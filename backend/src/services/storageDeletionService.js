const DEFAULT_RETRY_DELAY_MS = 30_000;
const STALE_LOCK_MINUTES = 5;
const MAX_ATTEMPTS_BEFORE_FAILED_STATUS = 10;

const parseObjectNames = (value) => {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value !== 'string') return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (error) {
    return [];
  }
};

const uniqueObjectNames = (values) => [...new Set((values || []).filter(Boolean))];

function createStorageDeletionService(dependencies = {}) {
  const pool = dependencies.pool || require('../config/database').pool;
  const storage = dependencies.storage || require('./storage');
  const retryDelayMs = Number.isFinite(dependencies.retryDelayMs)
    ? Math.max(0, dependencies.retryDelayMs)
    : Math.max(1_000, Number.parseInt(process.env.STORAGE_DELETE_RETRY_MS, 10) || DEFAULT_RETRY_DELAY_MS);

  async function createDeletionJob(client, data) {
    const immediateObjectNames = uniqueObjectNames(data.immediateObjectNames);
    const sharedObjectNames = uniqueObjectNames(data.sharedObjectNames);

    if (immediateObjectNames.length === 0 && sharedObjectNames.length === 0) return null;

    const result = await client.query(
      `INSERT INTO storage_deletion_jobs (
         patient_id,
         immediate_object_names,
         shared_object_names
       )
       VALUES ($1, $2::jsonb, $3::jsonb)
       RETURNING *`,
      [
        data.patientId,
        JSON.stringify(immediateObjectNames),
        JSON.stringify(sharedObjectNames),
      ]
    );

    return result.rows[0];
  }

  async function getDeletionJob(jobId) {
    const result = await pool.query(
      'SELECT * FROM storage_deletion_jobs WHERE id = $1',
      [jobId]
    );
    return result.rows[0] || null;
  }

  async function claimDeletionJob(jobId = null) {
    const idFilter = jobId === null ? '' : 'candidate.id = $1 AND';
    const params = jobId === null ? [] : [jobId];
    const result = await pool.query(
      `UPDATE storage_deletion_jobs AS job
       SET status = 'processing',
           attempts = job.attempts + 1,
           locked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE job.id = (
         SELECT candidate.id
         FROM storage_deletion_jobs AS candidate
         WHERE ${idFilter}
           (
             (candidate.status IN ('pending', 'failed') AND candidate.next_attempt_at <= CURRENT_TIMESTAMP)
             OR
             (candidate.status = 'processing'
              AND candidate.locked_at < CURRENT_TIMESTAMP - INTERVAL '${STALE_LOCK_MINUTES} minutes')
           )
         ORDER BY candidate.next_attempt_at, candidate.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING job.*`,
      params
    );

    return result.rows[0] || null;
  }

  async function isObjectReferenced(client, objectName) {
    const result = await client.query(
      `WITH object_references(value) AS (
         SELECT url FROM images
         UNION ALL
         SELECT url_processed FROM images WHERE url_processed IS NOT NULL
         UNION ALL
         SELECT annotation_file_url FROM visits WHERE annotation_file_url IS NOT NULL
       )
       SELECT EXISTS (
         SELECT 1
         FROM object_references
         WHERE value IS NOT NULL
           AND (
             split_part(split_part(value, '?', 1), '#', 1) = $1
             OR right(
                  split_part(split_part(value, '?', 1), '#', 1),
                  char_length($1) + 1
                ) = '/' || $1
           )
       ) AS referenced`,
      [objectName]
    );

    return Boolean(result.rows[0]?.referenced);
  }

  async function deleteSharedObjectIfUnreferenced(objectName) {
    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query('BEGIN');
      transactionStarted = true;

      // Writers of content-addressed objects use the same transaction-scoped lock.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [objectName]
      );

      if (await isObjectReferenced(client, objectName)) {
        await client.query('COMMIT');
        transactionStarted = false;
        return { status: 'preserved', objectName };
      }

      const deleteResult = await storage.deleteFiles([objectName]);
      if (!deleteResult.success) {
        throw new Error(deleteResult.error || `Failed to delete ${objectName}`);
      }

      await client.query('COMMIT');
      transactionStarted = false;
      return { status: 'deleted', objectName };
    } catch (error) {
      if (transactionStarted) {
        await client.query('ROLLBACK').catch((rollbackError) => {
          console.error('Shared storage deletion rollback failed:', rollbackError);
        });
      }
      return { status: 'failed', objectName, error: error.message };
    } finally {
      client.release();
    }
  }

  async function scheduleRetry(job, errorMessage) {
    const status = Number(job.attempts) >= MAX_ATTEMPTS_BEFORE_FAILED_STATUS
      ? 'failed'
      : 'pending';

    const result = await pool.query(
      `UPDATE storage_deletion_jobs
       SET status = $1,
           last_error = $2,
           next_attempt_at = CURRENT_TIMESTAMP + ($3::int * INTERVAL '1 millisecond'),
           locked_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *`,
      [status, errorMessage, retryDelayMs, job.id]
    );

    const updatedJob = result.rows[0] || job;

    return {
      jobId: updatedJob.id,
      status: updatedJob.status || status,
      deletedCount: Number(updatedJob.deleted_count) || 0,
      preservedCount: Number(updatedJob.preserved_count) || 0,
      error: errorMessage,
    };
  }

  async function processClaimedJob(job) {
    let immediateObjectNames = parseObjectNames(job.immediate_object_names);
    let sharedObjectNames = parseObjectNames(job.shared_object_names);
    let sharedDeletedDelta = 0;
    let preservedDelta = 0;

    try {
      if (immediateObjectNames.length > 0) {
        const deleteResult = await storage.deleteFiles(immediateObjectNames);
        if (!deleteResult.success) {
          throw new Error(deleteResult.error || 'MinIO immediate cleanup failed');
        }

        const immediateDeletedCount = immediateObjectNames.length;
        immediateObjectNames = [];

        // Persist progress after the idempotent remote call. A crash before this update
        // only causes the same object names to be retried safely.
        await pool.query(
          `UPDATE storage_deletion_jobs
           SET immediate_object_names = '[]'::jsonb,
               deleted_count = deleted_count + $1,
               last_error = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [immediateDeletedCount, job.id]
        );
      }

      const remainingSharedObjects = [];
      const sharedErrors = [];

      for (const objectName of sharedObjectNames) {
        const result = await deleteSharedObjectIfUnreferenced(objectName);
        if (result.status === 'deleted') {
          sharedDeletedDelta += 1;
        } else if (result.status === 'preserved') {
          preservedDelta += 1;
        } else {
          remainingSharedObjects.push(objectName);
          sharedErrors.push(`${objectName}: ${result.error}`);
        }
      }

      sharedObjectNames = remainingSharedObjects;
      const completed = immediateObjectNames.length === 0 && sharedObjectNames.length === 0;
      const status = completed ? 'completed' : 'pending';

      const result = await pool.query(
        `UPDATE storage_deletion_jobs
         SET shared_object_names = $1::jsonb,
             deleted_count = deleted_count + $2,
             preserved_count = preserved_count + $3,
             status = $4::varchar,
             last_error = $5,
             next_attempt_at = CASE
               WHEN $4::varchar = 'completed' THEN next_attempt_at
               ELSE CURRENT_TIMESTAMP + ($6::int * INTERVAL '1 millisecond')
             END,
             locked_at = NULL,
             updated_at = CURRENT_TIMESTAMP,
             completed_at = CASE WHEN $4::varchar = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END
         WHERE id = $7
         RETURNING *`,
        [
          JSON.stringify(sharedObjectNames),
          sharedDeletedDelta,
          preservedDelta,
          status,
          sharedErrors.length > 0 ? sharedErrors.join('; ') : null,
          retryDelayMs,
          job.id,
        ]
      );

      const updatedJob = result.rows[0];
      return {
        jobId: updatedJob.id,
        status: updatedJob.status,
        deletedCount: Number(updatedJob.deleted_count) || 0,
        preservedCount: Number(updatedJob.preserved_count) || 0,
        error: updatedJob.last_error || null,
      };
    } catch (error) {
      return scheduleRetry(job, error.message);
    }
  }

  async function processDeletionJob(jobId) {
    const claimedJob = await claimDeletionJob(jobId);
    if (claimedJob) return processClaimedJob(claimedJob);

    const existingJob = await getDeletionJob(jobId);
    if (!existingJob) return null;

    return {
      jobId: existingJob.id,
      status: existingJob.status,
      deletedCount: Number(existingJob.deleted_count) || 0,
      preservedCount: Number(existingJob.preserved_count) || 0,
      error: existingJob.last_error || null,
    };
  }

  async function processNextPendingDeletionJob() {
    const claimedJob = await claimDeletionJob();
    if (!claimedJob) return null;
    return processClaimedJob(claimedJob);
  }

  return {
    createDeletionJob,
    deleteSharedObjectIfUnreferenced,
    getDeletionJob,
    processDeletionJob,
    processNextPendingDeletionJob,
  };
}

let defaultService;

const getDefaultService = () => {
  if (!defaultService) defaultService = createStorageDeletionService();
  return defaultService;
};

module.exports = {
  createStorageDeletionService,
  createDeletionJob: (...args) => getDefaultService().createDeletionJob(...args),
  deleteSharedObjectIfUnreferenced: (...args) => getDefaultService().deleteSharedObjectIfUnreferenced(...args),
  getDeletionJob: (...args) => getDefaultService().getDeletionJob(...args),
  processDeletionJob: (...args) => getDefaultService().processDeletionJob(...args),
  processNextPendingDeletionJob: (...args) => getDefaultService().processNextPendingDeletionJob(...args),
};
