const { Worker } = require('bullmq');
const { connection } = require('../config/queue');
const storageService = require('../services/storage');
const { storeProcessedImageReference } = require('../services/processedImageReferenceService');
const imageProcessingService = require('../services/imageProcessingService');
const { Image, Annotation, Visit } = require('../models');
const annotationService = require('../services/annotationService');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const db = require('../config/database');
const {
  startStorageDeletionWorker,
  stopStorageDeletionWorker,
} = require('./storageDeletionWorker');

async function updateJobRecord(jobId, fields) {
  const sets = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }
  sets.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(jobId);
  await db.query(
    `UPDATE processing_jobs SET ${sets.join(', ')} WHERE id = $${idx}`,
    values
  );
}

async function processImagesJob(job) {
  const { visitId, userId } = job.data;
  let tempDir = null;

  try {
    await updateJobRecord(job.id, {
      status: 'processing',
      started_at: new Date(),
      progress: 5,
    });

    const rawImages = await Image.findByCategory(visitId, 'raw');

    if (rawImages.length === 0) {
      throw new Error('Không tìm thấy ảnh raw nào');
    }

    await updateJobRecord(job.id, { total_images: rawImages.length });
    await job.updateProgress(10);

    const images = [];
    const annotations = [];

    for (const img of rawImages) {
      const objectName = img.url.replace(/^\/[^/]+\//, '');
      const imageBuffer = await storageService.downloadFile(objectName);

      images.push({
        buffer: imageBuffer,
        filename: `image_${img.id}.jpg`,
      });

      const dbAnnotations = await Annotation.findByImageId(img.id);

      if (dbAnnotations.length === 0) {
        const dummyAnnotation = `11 0.5 0.5 0.1 0.15\n13 0.5 0.5 0.05 0.05`;
        annotations.push({
          buffer: Buffer.from(dummyAnnotation),
          filename: `image_${img.id}.txt`,
        });
      } else {
        const imageWidth = img.width || 6240;
        const imageHeight = img.height || 4160;
        const yoloAnnotations = Annotation.convertToYOLO(dbAnnotations, imageWidth, imageHeight);
        const yoloText = Annotation.formatYOLOText(yoloAnnotations);
        annotations.push({
          buffer: Buffer.from(yoloText),
          filename: `image_${img.id}.txt`,
        });
      }
    }

    await job.updateProgress(30);

    const zipBuffer = await imageProcessingService.divideCorners(images, annotations);

    await job.updateProgress(50);

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'processed-'));

    const zip = new AdmZip(zipBuffer);
    zip.extractAllTo(tempDir, true);

    const processedImagesPath = path.join(tempDir, 'images');
    const processedAnnotationsPath = path.join(tempDir, 'annotations');
    const processedFiles = await fs.readdir(processedImagesPath);
    const totalFiles = processedFiles.length;

    let processedCount = 0;

    for (const file of processedFiles) {
      const match = file.match(/image_(\d+)\./);
      if (!match) continue;

      const imageId = parseInt(match[1]);
      const originalImage = rawImages.find((img) => img.id === imageId);
      if (!originalImage) continue;

      const processedFilePath = path.join(processedImagesPath, file);
      const fileBuffer = await fs.readFile(processedFilePath);

      const originalFilename = path.basename(originalImage.url);
      const processedFilename = originalFilename.replace(/^raw_/, 'processed_');
      const ext = path.extname(processedFilename).replace(/^\./, '') || 'jpg';
      const storedImage = await storeProcessedImageReference(
        originalImage.id,
        fileBuffer,
        ext
      );
      if (!storedImage.success) {
        console.warn(
          `Failed to store processed image reference for image ${originalImage.id}: ${storedImage.error}`
        );
        continue;
      }

      const annotationFile = `image_${imageId}.txt`;
      const annotationPath = path.join(processedAnnotationsPath, annotationFile);

      try {
        const annotationContent = await fs.readFile(annotationPath, 'utf-8');
        await parseAndSaveSubboxes(
          imageId,
          annotationContent,
          1024,
          1024,
          originalImage.width || 6240,
          originalImage.height || 4160
        );
      } catch (annError) {
        console.warn(`Failed to parse annotations for image ${imageId}:`, annError.message);
      }

      processedCount++;
      const progress = 50 + Math.round((processedCount / totalFiles) * 45);
      await job.updateProgress(progress);
      await updateJobRecord(job.id, {
        processed_images: processedCount,
        progress,
      });
    }

    await Visit.markAsReprocessed(visitId, userId);

    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;

    const updatedImages = await Image.findByVisitId(visitId);
    const processedImages = updatedImages.filter((img) => img.url_processed);

    await updateJobRecord(job.id, {
      status: 'completed',
      progress: 100,
      completed_at: new Date(),
      processed_images: processedCount,
      result_data: JSON.stringify({
        totalImages: rawImages.length,
        processedImages: processedCount,
      }),
    });

    await job.updateProgress(100);

    return { visitId, processedCount, totalImages: rawImages.length };
  } catch (error) {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (e) {
        console.warn('Cleanup error:', e.message);
      }
    }

    await updateJobRecord(job.id, {
      status: 'failed',
      error_message: error.message,
      completed_at: new Date(),
    });

    throw error;
  }
}

async function parseAndSaveSubboxes(
  imageId,
  annotationContent,
  processedWidth,
  processedHeight,
  originalWidth,
  originalHeight
) {
  const lines = annotationContent.trim().split('\n').filter((line) => line.trim());

  await db.query(
    `DELETE FROM image_annotations
     WHERE image_id = $1
       AND parent_annotation_id IS NOT NULL
       AND (source_type IS NULL OR source_type != 'yolo_upload')`,
    [imageId]
  );

  if (!processedWidth || !processedHeight || processedWidth === 0 || processedHeight === 0) return;
  if (!originalWidth || !originalHeight || originalWidth === 0 || originalHeight === 0) return;

  const scaleX = originalWidth / processedWidth;
  const scaleY = originalHeight / processedHeight;

  const teethResult = await db.query(
    `SELECT id, category_id, category_name, bbox, coco_image_id
     FROM image_annotations
     WHERE image_id = $1
       AND parent_annotation_id IS NULL
       AND LOWER(category_name) NOT IN ('brace', 'bracket')
     ORDER BY id`,
    [imageId]
  );

  const dbTeeth = teethResult.rows;

  const teeth = [];
  const subboxes = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;

    const classId = parseInt(parts[0]);
    const xCenter = parseFloat(parts[1]);
    const yCenter = parseFloat(parts[2]);
    const width = parseFloat(parts[3]);
    const height = parseFloat(parts[4]);
    const toothId = parts.length === 6 ? parseInt(parts[5]) : null;

    const xProcessed = Math.round((xCenter - width / 2) * processedWidth);
    const yProcessed = Math.round((yCenter - height / 2) * processedHeight);
    const wProcessed = Math.round(width * processedWidth);
    const hProcessed = Math.round(height * processedHeight);

    if (toothId !== null) {
      const x = Math.round(xProcessed * scaleX);
      const y = Math.round(yProcessed * scaleY);
      const w = Math.round(wProcessed * scaleX);
      const h = Math.round(hProcessed * scaleY);
      subboxes.push({ classId, x, y, w, h, toothId });
    } else {
      const x = Math.round(xProcessed * scaleX);
      const y = Math.round(yProcessed * scaleY);
      const w = Math.round(wProcessed * scaleX);
      const h = Math.round(hProcessed * scaleY);
      teeth.push({ classId, x, y, w, h });
    }
  }

  const toothClassIdMap = {};
  for (const dbTooth of dbTeeth) {
    toothClassIdMap[dbTooth.category_id] = dbTooth.id;
  }

  for (const tooth of teeth) {
    if (!toothClassIdMap[tooth.classId]) {
      toothClassIdMap[tooth.classId] = dbTeeth.find(
        (dbTooth) => dbTooth.category_id === tooth.classId
      )?.id;
    }
  }

  const regionNames = ['top_left', 'top_right', 'bottom_left', 'bottom_right'];
  const regionIndexMap = {};

  for (const subbox of subboxes) {
    const parentId = toothClassIdMap[subbox.toothId];
    if (!parentId) continue;

    if (!(subbox.toothId in regionIndexMap)) regionIndexMap[subbox.toothId] = 0;
    const region = regionNames[regionIndexMap[subbox.toothId] % 4];
    regionIndexMap[subbox.toothId]++;

    const bbox = [subbox.x, subbox.y, subbox.w, subbox.h];
    const area = subbox.w * subbox.h;
    const plaqueStatus = subbox.classId === 0 ? 0 : 1;

    const existingSubbox = await db.query(
      `SELECT id FROM image_annotations
       WHERE image_id = $1 AND parent_annotation_id = $2 AND subbox_region = $3`,
      [imageId, parentId, region]
    );

    if (existingSubbox.rows.length > 0) {
      await db.query(
        `UPDATE image_annotations SET
          bbox = $1::jsonb, area = $2, category_id = $3, category_name = $4,
          predicted_plaque = $5, plaque_status = $6
        WHERE id = $7`,
        [JSON.stringify(bbox), area, subbox.classId, region, plaqueStatus, 1, existingSubbox.rows[0].id]
      );
    } else {
      await db.query(
        `INSERT INTO image_annotations (
          image_id, coco_image_id, category_id, category_name, bbox, area,
          parent_annotation_id, subbox_region, source_type, plaque_status, predicted_plaque
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'python_subbox', 1, $9)`,
        [
          imageId,
          dbTeeth.find((t) => t.id === parentId).coco_image_id,
          subbox.classId,
          region,
          JSON.stringify(bbox),
          area,
          parentId,
          region,
          plaqueStatus,
        ]
      );
    }
  }
}

let worker = null;

function startWorker() {
  if (worker) return worker;

  startStorageDeletionWorker();

  worker = new Worker('image-processing', processImagesJob, {
    connection,
    concurrency: 1,
    limiter: { max: 1, duration: 1000 },
  });

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed for visit ${job.data.visitId}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed for visit ${job?.data?.visitId}:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('Worker error:', err.message);
  });

  console.log('Image processing worker started');
  return worker;
}

async function stopWorker() {
  if (worker) {
    await worker.close();
    worker = null;
    console.log('Image processing worker stopped');
  }
  await stopStorageDeletionWorker();
}

module.exports = {
  startWorker,
  stopWorker,
  processImagesJob,
  storeProcessedImageReference,
};
