let timer;
let running;

async function reconcileProcessingJobs(dependencies = {}) {
  const pool = dependencies.pool || require('../config/database').pool;
  const queue = dependencies.queue || require('../config/queue').imageProcessingQueue;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobs = (await client.query(
      `SELECT * FROM processing_jobs WHERE status IN ('creating','queued','processing')
       AND updated_at < NOW() - INTERVAL '2 minutes' ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED`)).rows;
    for (const record of jobs) {
      const jobId = String(record.id);
      let job = await queue.getJob(jobId);
      if (!job) {
        // DB id is also the idempotency key for requests interrupted before enqueue.
        job = await queue.add('process-images', { visitId: record.visit_id, userId: record.created_by }, { jobId });
      }
      const state = await job.getState();
      let status = state === 'active' ? 'processing' : 'queued';
      if (state === 'failed') status = 'failed';
      if (state === 'completed') status = job.returnvalue?.status || 'completed';
      await client.query(
        `UPDATE processing_jobs SET bullmq_job_id=$2,status=$3,updated_at=NOW(),
         completed_at=CASE WHEN $3 IN ('completed','partial','review_required','failed') THEN COALESCE(completed_at,NOW()) ELSE NULL END
         WHERE id=$1`, [record.id, jobId, status]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

function startProcessingJobReconciler() {
  if (timer) return;
  const poll = () => {
    if (running) return;
    running = reconcileProcessingJobs().catch(error => console.error('Processing reconciliation:', error.message))
      .finally(() => { running = null; });
  };
  timer = setInterval(poll, 30000);
  timer.unref?.();
  poll();
}
async function stopProcessingJobReconciler() {
  clearInterval(timer); timer = null;
  if (running) await running;
}
module.exports = { reconcileProcessingJobs, startProcessingJobReconciler, stopProcessingJobReconciler };
