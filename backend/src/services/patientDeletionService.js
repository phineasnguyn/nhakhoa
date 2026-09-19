class PatientDeletionError extends Error {
  constructor(message, statusCode = 500, code = 'PATIENT_DELETE_FAILED') {
    super(message);
    this.name = 'PatientDeletionError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const toNumber = (value) => Number.parseInt(value, 10) || 0;

function createPatientDeletionService(dependencies = {}) {
  const getDependencies = () => {
    const pool = dependencies.pool || require('../config/database').pool;
    const storage = dependencies.storage || require('./storage');
    const storageDeletion = dependencies.storageDeletion
      || require('./storageDeletionService').createStorageDeletionService({ pool, storage });

    return {
      pool,
      storage,
      storageDeletion,
      queue: dependencies.queue || require('../config/queue').imageProcessingQueue,
    };
  };

  async function inspectAndRemoveQueueJobs(queue, jobRecords) {
    const removableJobs = [];
    const activeDatabaseStatuses = new Set(['creating', 'queued', 'processing']);

    try {
      // Inspect every job first so an active job never results in a partial cancellation.
      for (const record of jobRecords) {
        if (!record.bullmq_job_id) {
          if (activeDatabaseStatuses.has(record.status)) {
            throw new PatientDeletionError(
              'Không thể xác minh image-processing job đang chạy. Vui lòng kiểm tra lại job trước khi xóa.',
              409,
              'PATIENT_PROCESSING_ACTIVE'
            );
          }
          continue;
        }

        const job = await queue.getJob(record.bullmq_job_id);
        if (!job) {
          if (activeDatabaseStatuses.has(record.status)) {
            throw new PatientDeletionError(
              'Không tìm thấy image-processing job đang hoạt động trong BullMQ. Vui lòng đồng bộ trạng thái job trước khi xóa.',
              409,
              'PATIENT_PROCESSING_ACTIVE'
            );
          }
          continue;
        }

        const state = await job.getState();
        if (state === 'active') {
          throw new PatientDeletionError(
            'Bệnh nhân đang có ảnh được xử lý. Vui lòng thử lại sau khi job hoàn tất.',
            409,
            'PATIENT_PROCESSING_ACTIVE'
          );
        }

        removableJobs.push({ job, record, state });
      }

      const removedDatabaseJobIds = [];
      for (const item of removableJobs) {
        try {
          await item.job.remove();
          removedDatabaseJobIds.push(item.record.id);
        } catch (error) {
          const currentState = await item.job.getState().catch(() => null);
          if (currentState === 'active') {
            throw new PatientDeletionError(
              'Bệnh nhân vừa bắt đầu xử lý ảnh. Vui lòng thử lại sau khi job hoàn tất.',
              409,
              'PATIENT_PROCESSING_ACTIVE'
            );
          }
          throw error;
        }
      }

      return removedDatabaseJobIds;
    } catch (error) {
      if (error instanceof PatientDeletionError) throw error;
      throw new PatientDeletionError(
        `Không thể kiểm tra hoặc hủy image-processing job: ${error.message}`,
        503,
        'PATIENT_QUEUE_CLEANUP_FAILED'
      );
    }
  }

  async function markCancelledJobsAfterRollback(pool, jobIds, reason) {
    if (jobIds.length === 0 || typeof pool.query !== 'function') return;

    try {
      await pool.query(
        `UPDATE processing_jobs
         SET status = 'failed',
             error_message = $1,
             completed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($2::int[])
           AND status IN ('queued', 'processing')`,
        [reason, jobIds]
      );
    } catch (error) {
      console.error('Failed to mark cancelled processing jobs after patient delete rollback:', error);
    }
  }

  async function deletePatient(patientId) {
    const parsedPatientId = Number(patientId);
    if (!Number.isInteger(parsedPatientId) || parsedPatientId <= 0) {
      throw new PatientDeletionError('Patient ID không hợp lệ', 400, 'INVALID_PATIENT_ID');
    }

    const { pool, storage, storageDeletion, queue } = getDependencies();
    const client = await pool.connect();
    let transactionStarted = false;
    let removedQueueJobIds = [];

    try {
      await client.query('BEGIN');
      transactionStarted = true;

      const patientResult = await client.query(
        'SELECT id, name FROM patients WHERE id = $1 FOR UPDATE',
        [parsedPatientId]
      );

      if (patientResult.rows.length === 0) {
        throw new PatientDeletionError('Không tìm thấy bệnh nhân', 404, 'PATIENT_NOT_FOUND');
      }

      const visitsResult = await client.query(
        `SELECT id, annotation_file_url
         FROM visits
         WHERE patient_id = $1
         FOR UPDATE`,
        [parsedPatientId]
      );
      const visitIds = visitsResult.rows.map((visit) => visit.id);

      const imagesResult = await client.query(
        `SELECT i.id, i.url, i.url_processed
         FROM images i
         JOIN visits v ON v.id = i.visit_id
         WHERE v.patient_id = $1
         FOR UPDATE OF i`,
        [parsedPatientId]
      );

      const countsResult = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM cases c WHERE c.patient_id = $1)::int AS cases,
           (SELECT COUNT(*) FROM case_doctors cd JOIN cases c ON c.id = cd.case_id WHERE c.patient_id = $1)::int AS case_doctors,
           (SELECT COUNT(*) FROM image_annotations ia JOIN images i ON i.id = ia.image_id JOIN visits v ON v.id = i.visit_id WHERE v.patient_id = $1)::int AS annotations,
           (SELECT COUNT(*) FROM annotation_history ah JOIN image_annotations ia ON ia.id = ah.annotation_id JOIN images i ON i.id = ia.image_id JOIN visits v ON v.id = i.visit_id WHERE v.patient_id = $1)::int AS annotation_history,
           (SELECT COUNT(*) FROM image_validations iv JOIN images i ON i.id = iv.image_id JOIN visits v ON v.id = i.visit_id WHERE v.patient_id = $1)::int AS image_validations,
           (SELECT COUNT(*) FROM subboxes s JOIN images i ON i.id = s.image_id JOIN visits v ON v.id = i.visit_id WHERE v.patient_id = $1)::int AS subboxes,
           (SELECT COUNT(*) FROM labels l JOIN images i ON i.id = l.image_id JOIN visits v ON v.id = i.visit_id WHERE v.patient_id = $1)::int AS labels`,
        [parsedPatientId]
      );

      const jobsResult = visitIds.length > 0
        ? await client.query(
            `SELECT id, bullmq_job_id, status
             FROM processing_jobs
             WHERE visit_id = ANY($1::int[])
             FOR UPDATE`,
            [visitIds]
          )
        : { rows: [] };

      const candidateObjectNames = new Set();
      const addObjectName = (value) => {
        const objectName = storage.extractObjectName(value);
        if (objectName) candidateObjectNames.add(objectName);
      };

      for (const image of imagesResult.rows) {
        addObjectName(image.url);
        addObjectName(image.url_processed);
      }
      for (const visit of visitsResult.rows) {
        addObjectName(visit.annotation_file_url);
      }

      try {
        // Prefix cleanup also catches replaced/orphaned files no longer referenced by DB metadata.
        for (const visitId of visitIds) {
          const prefixObjects = await storage.listFilesByPrefix(`visits/${visitId}/`);
          prefixObjects.forEach((objectName) => candidateObjectNames.add(objectName));
        }
      } catch (error) {
        throw new PatientDeletionError(
          `Không thể liệt kê ảnh trong MinIO: ${error.message}`,
          502,
          'PATIENT_MINIO_LIST_FAILED'
        );
      }

      const externalReferencesResult = await client.query(
        `SELECT url AS value
           FROM images i
           LEFT JOIN visits v ON v.id = i.visit_id
          WHERE v.patient_id IS DISTINCT FROM $1
         UNION ALL
         SELECT url_processed AS value
           FROM images i
           LEFT JOIN visits v ON v.id = i.visit_id
          WHERE v.patient_id IS DISTINCT FROM $1
            AND url_processed IS NOT NULL
         UNION ALL
         SELECT annotation_file_url AS value
           FROM visits
          WHERE patient_id IS DISTINCT FROM $1
            AND annotation_file_url IS NOT NULL`,
        [parsedPatientId]
      );

      const externallyReferencedObjects = new Set(
        externalReferencesResult.rows
          .map((row) => storage.extractObjectName(row.value))
          .filter(Boolean)
      );

      const snapshotPreservedSharedObjects = [...candidateObjectNames].filter(
        (objectName) => objectName.startsWith('processed_by_hash/')
          && externallyReferencedObjects.has(objectName)
      ).length;
      // Every content-addressed candidate goes through the locked, fresh reference
      // check. This also cleans the object correctly when two patients sharing it
      // are deleted concurrently.
      const sharedObjectNames = [...candidateObjectNames].filter(
        (objectName) => objectName.startsWith('processed_by_hash/')
      );
      const immediateObjectNames = [...candidateObjectNames].filter(
        (objectName) => !objectName.startsWith('processed_by_hash/')
          && !externallyReferencedObjects.has(objectName)
      );

      removedQueueJobIds = await inspectAndRemoveQueueJobs(queue, jobsResult.rows);

      const deletionJob = await storageDeletion.createDeletionJob(client, {
        patientId: parsedPatientId,
        immediateObjectNames,
        sharedObjectNames,
      });

      const deleteResult = await client.query(
        'DELETE FROM patients WHERE id = $1 RETURNING id',
        [parsedPatientId]
      );
      if (deleteResult.rowCount !== 1) {
        throw new PatientDeletionError('Không thể xóa bệnh nhân', 500, 'PATIENT_DATABASE_DELETE_FAILED');
      }

      await client.query('COMMIT');
      transactionStarted = false;

      let storageCleanupResult = {
        jobId: null,
        status: 'completed',
        deletedCount: 0,
        preservedCount: 0,
        error: null,
      };

      if (deletionJob) {
        try {
          storageCleanupResult = await storageDeletion.processDeletionJob(deletionJob.id)
            || {
              jobId: deletionJob.id,
              status: 'pending',
              deletedCount: 0,
              preservedCount: 0,
              error: 'Storage cleanup job has not been claimed yet',
            };
        } catch (cleanupError) {
          // The outbox was committed with the patient deletion. The background worker
          // will retry, so a remote cleanup failure never rolls the database back.
          console.error('Initial patient storage cleanup failed:', cleanupError);
          storageCleanupResult = {
            jobId: deletionJob.id,
            status: 'pending',
            deletedCount: 0,
            preservedCount: 0,
            error: cleanupError.message,
          };
        }
      }

      const dependencyCounts = countsResult.rows[0] || {};
      return {
        patientId: parsedPatientId,
        patientName: patientResult.rows[0].name,
        deletedVisits: visitsResult.rows.length,
        deletedImages: imagesResult.rows.length,
        deletedAnnotations: toNumber(dependencyCounts.annotations),
        deletedAnnotationHistory: toNumber(dependencyCounts.annotation_history),
        deletedImageValidations: toNumber(dependencyCounts.image_validations),
        deletedSubboxes: toNumber(dependencyCounts.subboxes),
        deletedLabels: toNumber(dependencyCounts.labels),
        deletedCases: toNumber(dependencyCounts.cases),
        deletedCaseDoctors: toNumber(dependencyCounts.case_doctors),
        deletedProcessingJobs: jobsResult.rows.length,
        deletedMinioObjects: storageCleanupResult.deletedCount || 0,
        preservedSharedObjects: storageCleanupResult.status === 'completed'
          ? (storageCleanupResult.preservedCount || 0)
          : snapshotPreservedSharedObjects,
        storageCleanupStatus: storageCleanupResult.status,
        storageDeletionJobId: storageCleanupResult.jobId,
        storageCleanupError: storageCleanupResult.error || null,
      };
    } catch (error) {
      if (transactionStarted) {
        await client.query('ROLLBACK').catch((rollbackError) => {
          console.error('Patient deletion rollback failed:', rollbackError);
        });
      }

      if (removedQueueJobIds.length > 0) {
        await markCancelledJobsAfterRollback(
          pool,
          removedQueueJobIds,
          'Image-processing job was cancelled during a patient deletion that later failed'
        );
      }

      throw error;
    } finally {
      client.release();
    }
  }

  return { deletePatient };
}

let defaultService;

const deletePatient = async (patientId) => {
  if (!defaultService) defaultService = createPatientDeletionService();
  return defaultService.deletePatient(patientId);
};

module.exports = {
  PatientDeletionError,
  createPatientDeletionService,
  deletePatient,
};
