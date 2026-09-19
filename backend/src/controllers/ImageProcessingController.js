const { Image } = require('../models');
const { presentImage } = require('../services/imagePresentation');
const { processingQueueId } = require('../services/processingJobIdentity');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

class ImageProcessingController {
  constructor(dependencies = {}) {
    this.queue = dependencies.queue || null;
    this.database = dependencies.database || null;
  }

  getQueue() {
    if (!this.queue) this.queue = require('../config/queue').imageProcessingQueue;
    return this.queue;
  }

  getDatabase() {
    if (!this.database) this.database = require('../config/database');
    return this.database;
  }

  async processRawImages(req, res) {
    const visitId = Number(req.params.visitId);
    let processingJob = null;

    try {
      if (!Number.isInteger(visitId) || visitId <= 0) {
        throw httpError(400, 'Visit ID không hợp lệ');
      }
      const database = this.getDatabase();
      const queue = this.getQueue();

      const client = await database.pool.connect();
      let transactionStarted = false;

      try {
        await client.query('BEGIN');
        transactionStarted = true;

        // Serialize job creation with patient deletion through the visit row.
        const visitResult = await client.query(
          `SELECT id
           FROM visits
           WHERE id = $1 AND deleted_at IS NULL
           FOR UPDATE`,
          [visitId]
        );
        if (visitResult.rows.length === 0) {
          throw httpError(404, 'Visit not found');
        }

        const rawImagesResult = await client.query(
          `SELECT COUNT(*)::int AS total
           FROM images
           WHERE visit_id = $1
             AND image_category = 'raw'
             AND deleted_at IS NULL`,
          [visitId]
        );
        const totalImages = rawImagesResult.rows[0]?.total || 0;
        if (totalImages === 0) {
          throw httpError(400, 'Không tìm thấy ảnh raw nào');
        }

        const activeJobResult = await client.query(
          `SELECT id, status, progress
           FROM processing_jobs
           WHERE visit_id = $1
             AND status IN ('creating', 'queued', 'processing')
           ORDER BY created_at DESC
           LIMIT 1`,
          [visitId]
        );

        if (activeJobResult.rows.length > 0) {
          const activeJob = activeJobResult.rows[0];
          await client.query('ROLLBACK');
          transactionStarted = false;
          return res.status(409).json({
            success: false,
            error: 'Đang có job xử lý ảnh cho visit này',
            data: {
              jobId: activeJob.id,
              status: activeJob.status,
              progress: activeJob.progress,
            },
          });
        }

        const insertResult = await client.query(
          `INSERT INTO processing_jobs (visit_id, status, total_images, created_by)
           VALUES ($1, 'creating', $2, $3)
           RETURNING *`,
          [visitId, totalImages, req.user?.id || null]
        );
        processingJob = insertResult.rows[0];

        await client.query('COMMIT');
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) {
          await client.query('ROLLBACK').catch((rollbackError) => {
            console.error('Processing job creation rollback failed:', rollbackError);
          });
        }
        throw error;
      } finally {
        client.release();
      }

      let bullJob = null;
      try {
        bullJob = await queue.add(
          'process-images',
          {
            visitId,
            userId: req.user?.id || null,
            processingJobId: processingJob.id,
          },
          {
            priority: 1,
            jobId: processingQueueId(processingJob.id),
          }
        );

        const updateResult = await database.query(
          `UPDATE processing_jobs
           SET bullmq_job_id = $1,
               status = CASE WHEN status = 'creating' THEN 'queued' ELSE status END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2
           RETURNING *`,
          [bullJob.id, processingJob.id]
        );
        if (updateResult.rows.length > 0) processingJob = updateResult.rows[0];
      } catch (enqueueError) {
        if (bullJob) {
          await bullJob.remove().catch(() => {
            // An active worker owns the job and will update the same database id.
          });
        }

        await database.query(
          `UPDATE processing_jobs
           SET status = CASE WHEN status = 'creating' THEN 'failed' ELSE status END,
               error_message = CASE WHEN status = 'creating' THEN $1 ELSE error_message END,
               completed_at = CASE WHEN status = 'creating' THEN CURRENT_TIMESTAMP ELSE completed_at END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [enqueueError.message, processingJob.id]
        ).catch((updateError) => {
          console.error('Failed to mark image-processing enqueue error:', updateError);
        });

        throw enqueueError;
      }

      res.status(202).json({
        success: true,
        data: {
          jobId: processingJob.id,
          bullmqJobId: bullJob.id,
          status: processingJob.status,
          totalImages: processingJob.total_images,
          message: 'Đã enqueue job xử lý ảnh',
        },
      });
    } catch (error) {
      console.error('Error enqueueing image processing job:', error);
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.message,
      });
    }
  }

  async getProcessingStatus(req, res) {
    try {
      const database = this.getDatabase();
      const queue = this.getQueue();
      const { visitId } = req.params;
      const requestedJobId = req.query?.jobId;
      if (requestedJobId && !/^\d+$/.test(String(requestedJobId))) {
        return res.status(400).json({ success: false, error: 'Invalid jobId' });
      }

      const latestJobResult = await database.query(
        `SELECT * FROM processing_jobs
         WHERE visit_id = $1 ${requestedJobId ? 'AND id = $2' : ''}
         ORDER BY created_at DESC
         LIMIT 1`,
        requestedJobId ? [visitId, requestedJobId] : [visitId]
      );

      if (latestJobResult.rows.length === 0) {
        if (requestedJobId) return res.status(404).json({ success: false, error: 'Job not found' });
        const rawImages = await Image.findByCategory(visitId, 'raw');
        const processedCount = rawImages.filter((img) => presentImage(img).render_mode !== 'raw').length;

        return res.json({
          success: true,
          data: {
            jobId: null,
            status: processedCount === 0 ? 'none' : processedCount < rawImages.length ? 'partial' : 'completed',
            progress: rawImages.length > 0 ? Math.round((processedCount / rawImages.length) * 100) : 0,
            totalImages: rawImages.length,
            processedImages: processedCount,
          },
        });
      }

      const job = latestJobResult.rows[0];

      let bullmqState = null;
      try {
        const bullJob = await queue.getJob(job.bullmq_job_id || processingQueueId(job.id));
        if (bullJob) {
          bullmqState = await bullJob.getState();
        }
      } catch (e) {
        // BullMQ job may have been removed after completion
      }

      let status = job.status;
      if (bullmqState === 'active') status = 'processing';
      else if (bullmqState === 'completed' && !['partial', 'review_required'].includes(job.status)) status = 'completed';
      else if (bullmqState === 'failed') status = 'failed';
      else if (['waiting', 'delayed', 'prioritized'].includes(bullmqState)) status = 'queued';

      res.json({
        success: true,
        data: {
          jobId: job.id,
          status,
          progress: job.progress,
          totalImages: job.total_images,
          processedImages: job.processed_images ?? 0,
          results: job.result_data?.results || [],
          errorMessage: job.error_message,
          createdAt: job.created_at,
          startedAt: job.started_at,
          completedAt: job.completed_at,
        },
      });
    } catch (error) {
      console.error('Error getting processing status:', error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
}

const controller = new ImageProcessingController();

module.exports = {
  processRawImages: controller.processRawImages.bind(controller),
  getProcessingStatus: controller.getProcessingStatus.bind(controller),
  ImageProcessingController,
};
