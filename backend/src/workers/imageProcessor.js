const { Worker } = require('bullmq');
const { connection } = require('../config/queue');
const db = require('../config/database');
const { Image, Visit } = require('../models');
const { createImageOverlayService } = require('../services/imageOverlayService');
const { processingDatabaseId } = require('../services/processingJobIdentity');
const { startStorageDeletionWorker, stopStorageDeletionWorker } = require('./storageDeletionWorker');
const { startProcessingJobReconciler, stopProcessingJobReconciler } = require('./processingJobReconciler');

async function processImagesJob(job) {
  const { visitId, userId } = job.data;
  const databaseJobId = processingDatabaseId(job);
  const service = createImageOverlayService();
  const results = [];
  try {
    await db.query("UPDATE processing_jobs SET status='processing',started_at=COALESCE(started_at,NOW()),completed_at=NULL,error_message=NULL,updated_at=NOW() WHERE id=$1", [databaseJobId]);
    const images = await Image.findByCategory(visitId, 'raw');
    if (!images.length) throw new Error('Không tìm thấy ảnh raw nào');
    await db.query('UPDATE processing_jobs SET total_images=$2 WHERE id=$1', [databaseJobId, images.length]);
    let transientError;
    for (const image of images) {
      try {
        results.push(await service.processImage(image.id));
      } catch (error) {
        const review = error.code === 'OVERLAY_REVIEW_REQUIRED';
        results.push({ imageId: image.id, status: review ? 'review_required' : 'failed', reason: error.message });
        if (review) {
          // Do not replace a newer result that a concurrent request already committed.
          await db.query(`UPDATE images SET overlay_review_reason=$2 WHERE id=$1
            AND image_revision=$3 AND annotation_revision=$4
            AND NOT (processing_status='completed' AND overlay_schema_version=1
              AND processed_image_revision=image_revision) IS TRUE`,
            [image.id, error.message, image.image_revision, image.annotation_revision]);
        } else transientError = error;
      }
      const progress = Math.round(results.length / images.length * 100);
      await job.updateProgress(progress);
      await db.query(
        'UPDATE processing_jobs SET progress=$2,processed_images=$3,result_data=$4::jsonb,updated_at=NOW() WHERE id=$1',
        [databaseJobId, progress, results.filter(r => r.status === 'completed').length, JSON.stringify({ results })]);
    }
    if (transientError) throw transientError;
    const processedCount = results.filter(r => r.status === 'completed').length;
    const status = processedCount === images.length ? 'completed' : processedCount ? 'partial' : 'review_required';
    if (status === 'completed') await Visit.markAsReprocessed(visitId, userId);
    const summary = { visitId, status, processedCount, totalImages: images.length, results };
    await db.query(
      'UPDATE processing_jobs SET status=$2,progress=100,processed_images=$3,result_data=$4::jsonb,completed_at=NOW(),updated_at=NOW() WHERE id=$1',
      [databaseJobId, status, processedCount, JSON.stringify(summary)]);
    return summary;
  } catch (error) {
    const retrying = job.attemptsMade + 1 < (job.opts.attempts || 1);
    await db.query(
      "UPDATE processing_jobs SET status=$2::varchar,error_message=$3,completed_at=CASE WHEN $2::varchar='failed' THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$1",
      [databaseJobId, retrying ? 'queued' : 'failed', error.message]);
    throw error;
  }
}

let worker;
function startWorker() {
  if (worker) return worker;
  startStorageDeletionWorker();
  startProcessingJobReconciler();
  worker = new Worker('image-processing', processImagesJob, {
    connection, concurrency: 1, limiter: { max: 1, duration: 1000 },
  });
  worker.on('error', error => console.error('Image worker error:', error.message));
  worker.on('failed', (job, error) => console.error('Image job failed:', job?.id, error.message));
  return worker;
}
async function stopWorker() {
  await stopProcessingJobReconciler();
  if (worker) { await worker.close(); worker = null; }
  await stopStorageDeletionWorker();
}
module.exports = { startWorker, stopWorker, processImagesJob };
