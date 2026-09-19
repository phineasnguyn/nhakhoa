const test = require('node:test');
const assert = require('node:assert/strict');

const shouldRun = process.env.RUN_PATIENT_DELETE_INTEGRATION === 'true';

test('hard-deletes the complete patient graph and MinIO objects', { skip: !shouldRun }, async () => {
  require('dotenv').config();
  const db = require('../config/database');
  const storage = require('./storage');
  const storageDeletion = require('./storageDeletionService');
  const { createPatientDeletionService } = require('./patientDeletionService');

  const targetPatientId = 900001;
  const otherPatientId = 900002;
  const targetVisitId = 910001;
  const otherVisitId = 910002;
  const targetImageId = 920001;
  const otherImageId = 920002;
  const targetPrefix = `visits/${targetVisitId}/`;
  const targetRawObject = `${targetPrefix}raw.jpg`;
  const targetAnnotationObject = `${targetPrefix}annotations/data.json`;
  const targetOrphanObject = `${targetPrefix}old-replaced.jpg`;
  const otherRawObject = `visits/${otherVisitId}/raw.jpg`;
  const sharedProcessedObject = 'processed_by_hash/integration-shared.jpg';
  const allFixtureObjects = [
    targetRawObject,
    targetAnnotationObject,
    targetOrphanObject,
    otherRawObject,
    sharedProcessedObject,
  ];

  const queue = {
    async getJob() {
      throw new Error('Fixture processing job has no BullMQ id and must not be queried');
    },
  };

  const service = createPatientDeletionService({
    pool: db.pool,
    storage,
    queue,
  });

  try {
    await db.query(
      'DELETE FROM storage_deletion_jobs WHERE patient_id = ANY($1::int[])',
      [[targetPatientId, otherPatientId]]
    );
    await db.query('DELETE FROM patients WHERE id = ANY($1::int[])', [[targetPatientId, otherPatientId]]);
    await storage.deleteFiles(allFixtureObjects);

    await db.query(
      `INSERT INTO patients (id, name) VALUES ($1, 'Delete integration target'), ($2, 'Delete integration keeper')`,
      [targetPatientId, otherPatientId]
    );
    await db.query(
      `INSERT INTO cases (id, patient_id, treatment_type) VALUES (930001, $1, 'integration-test')`,
      [targetPatientId]
    );

    const doctorResult = await db.query('SELECT id FROM doctors ORDER BY id LIMIT 1');
    if (doctorResult.rows[0]) {
      await db.query(
        `INSERT INTO case_doctors (case_id, doctor_id, role) VALUES (930001, $1, 'integration-test')`,
        [doctorResult.rows[0].id]
      );
    }

    await db.query(
      `INSERT INTO visits (id, patient_id, case_id, visit_date, annotation_file_url)
       VALUES ($1, $2, 930001, CURRENT_DATE, $3), ($4, $5, NULL, CURRENT_DATE, NULL)`,
      [
        targetVisitId,
        targetPatientId,
        `/nhakhoa/${targetAnnotationObject}`,
        otherVisitId,
        otherPatientId,
      ]
    );
    await db.query(
      `INSERT INTO images (id, visit_id, url, url_processed, image_category)
       VALUES ($1, $2, $3, $4, 'raw'), ($5, $6, $7, $4, 'raw')`,
      [
        targetImageId,
        targetVisitId,
        `/nhakhoa/${targetRawObject}`,
        `/nhakhoa/${sharedProcessedObject}`,
        otherImageId,
        otherVisitId,
        `/nhakhoa/${otherRawObject}`,
      ]
    );

    const annotationResult = await db.query(
      `INSERT INTO image_annotations (image_id, coco_image_id, category_id, category_name, bbox)
       VALUES ($1, 1, 1, '11', '[0,0,10,10]'::jsonb)
       RETURNING id`,
      [targetImageId]
    );
    const parentAnnotationId = annotationResult.rows[0].id;
    const childAnnotationResult = await db.query(
      `INSERT INTO image_annotations (image_id, coco_image_id, category_id, category_name, bbox, parent_annotation_id)
       VALUES ($1, 1, 1, 'top_left', '[0,0,5,5]'::jsonb, $2)
       RETURNING id`,
      [targetImageId, parentAnnotationId]
    );
    const childAnnotationId = childAnnotationResult.rows[0].id;
    const historyResult = await db.query(
      `INSERT INTO annotation_history (annotation_id, old_value, new_value)
       VALUES ($1, 0, 1)
       RETURNING id`,
      [parentAnnotationId]
    );
    const subboxResult = await db.query(
      `INSERT INTO subboxes (image_id, region, coordinates, box_type)
       VALUES ($1, 'top_left', '[0,0,5,5]'::jsonb, 'integration-test')
       RETURNING id`,
      [targetImageId]
    );
    const labelResult = await db.query(
      `INSERT INTO labels (image_id, subbox_id, label_type, value)
       VALUES ($1, $2, 'plaque', '1')
       RETURNING id`,
      [targetImageId, subboxResult.rows[0].id]
    );
    const validationResult = await db.query(
      `INSERT INTO image_validations (image_id, criteria, result)
       VALUES ($1, 'integration-test', true)
       RETURNING id`,
      [targetImageId]
    );
    await db.query(
      `INSERT INTO processing_jobs (visit_id, status, total_images) VALUES ($1, 'completed', 1)`,
      [targetVisitId]
    );

    for (const objectName of allFixtureObjects) {
      await storage.uploadFromBuffer(Buffer.from(`fixture:${objectName}`), objectName, 'application/octet-stream');
    }

    const result = await service.deletePatient(targetPatientId);

    assert.equal(result.deletedVisits, 1);
    assert.equal(result.deletedImages, 1);
    assert.equal(result.deletedAnnotations, 2);
    assert.equal(result.deletedProcessingJobs, 1);
    assert.equal(result.preservedSharedObjects, 1);
    assert.ok(['pending', 'processing', 'completed'].includes(result.storageCleanupStatus));

    let deletionJobResult = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await storageDeletion.processDeletionJob(result.storageDeletionJobId);
      deletionJobResult = await db.query(
        `SELECT status, deleted_count, preserved_count, last_error,
                immediate_object_names, shared_object_names
         FROM storage_deletion_jobs
         WHERE id = $1`,
        [result.storageDeletionJobId]
      );
      if (deletionJobResult.rows[0]?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.deepEqual(deletionJobResult.rows[0], {
      status: 'completed',
      deleted_count: 3,
      preserved_count: 1,
      last_error: null,
      immediate_object_names: [],
      shared_object_names: [],
    });

    const remainingTargetRows = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM patients WHERE id = $1)::int AS patients,
         (SELECT COUNT(*) FROM visits WHERE patient_id = $1)::int AS visits,
         (SELECT COUNT(*) FROM images WHERE visit_id = $2)::int AS images,
         (SELECT COUNT(*) FROM processing_jobs WHERE visit_id = $2)::int AS jobs,
         (SELECT COUNT(*) FROM cases WHERE id = 930001)::int AS cases,
         (SELECT COUNT(*) FROM case_doctors WHERE case_id = 930001)::int AS case_doctors,
         (SELECT COUNT(*) FROM image_annotations WHERE id = ANY($3::int[]))::int AS annotations,
         (SELECT COUNT(*) FROM annotation_history WHERE id = $4)::int AS annotation_history,
         (SELECT COUNT(*) FROM subboxes WHERE id = $5)::int AS subboxes,
         (SELECT COUNT(*) FROM labels WHERE id = $6)::int AS labels,
         (SELECT COUNT(*) FROM image_validations WHERE id = $7)::int AS validations`,
      [
        targetPatientId,
        targetVisitId,
        [parentAnnotationId, childAnnotationId],
        historyResult.rows[0].id,
        subboxResult.rows[0].id,
        labelResult.rows[0].id,
        validationResult.rows[0].id,
      ]
    );
    assert.deepEqual(remainingTargetRows.rows[0], {
      patients: 0,
      visits: 0,
      images: 0,
      jobs: 0,
      cases: 0,
      case_doctors: 0,
      annotations: 0,
      annotation_history: 0,
      subboxes: 0,
      labels: 0,
      validations: 0,
    });

    assert.equal(await storage.objectExists(targetRawObject), false);
    assert.equal(await storage.objectExists(targetAnnotationObject), false);
    assert.equal(await storage.objectExists(targetOrphanObject), false);
    assert.equal(await storage.objectExists(sharedProcessedObject), true);
    assert.equal(await storage.objectExists(otherRawObject), true);

    const keeperResult = await db.query('SELECT id FROM patients WHERE id = $1', [otherPatientId]);
    assert.equal(keeperResult.rowCount, 1);

    // Delete the final referencing patient. The same content-addressed object is
    // scheduled again, rechecked under the advisory lock, and then removed.
    const keeperDeletionResult = await service.deletePatient(otherPatientId);
    let keeperDeletionJob = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await storageDeletion.processDeletionJob(keeperDeletionResult.storageDeletionJobId);
      keeperDeletionJob = await db.query(
        `SELECT status, deleted_count, preserved_count
         FROM storage_deletion_jobs
         WHERE id = $1`,
        [keeperDeletionResult.storageDeletionJobId]
      );
      if (keeperDeletionJob.rows[0]?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.deepEqual(keeperDeletionJob.rows[0], {
      status: 'completed',
      deleted_count: 2,
      preserved_count: 0,
    });
    assert.equal(await storage.objectExists(sharedProcessedObject), false);
    assert.equal(await storage.objectExists(otherRawObject), false);

  } finally {
    await db.query('DELETE FROM patients WHERE id = ANY($1::int[])', [[targetPatientId, otherPatientId]]);
    await db.query(
      'DELETE FROM storage_deletion_jobs WHERE patient_id = ANY($1::int[])',
      [[targetPatientId, otherPatientId]]
    );
    await storage.deleteFiles(allFixtureObjects);
    await db.pool.end();
  }
});
