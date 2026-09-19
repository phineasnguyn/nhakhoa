# Delete Patient Cascade - Implementation Report

## Branch

`feature/delete-patient`, based on `origin/dev` (`aa93d0e`).

The branch restores only the BullMQ components required by this feature. Unrelated changes from the old pre-revert implementation were not brought into the branch.

## 1. Problem

`DELETE /api/patients/:id` previously called `Patient.delete()`, which only set `patients.deleted_at`. Related visits, images, annotations, processing jobs, and MinIO objects remained in place.

The database already cascaded most relationships:

- `patients -> cases -> case_doctors`
- `patients -> visits -> images`
- `images -> image_annotations -> annotation_history`
- `images -> image_validations`
- `images -> subboxes` and `images -> labels`

However, `processing_jobs.visit_id` used the default `NO ACTION` delete rule and blocked hard deletion of visits with processing history.

MinIO cleanup also needs special handling:

- Visit-owned files normally live below `visits/{visitId}/`.
- Image metadata points to MinIO through `images.url` and `images.url_processed`.
- COCO metadata points to MinIO through `visits.annotation_file_url`.
- Processed images use content-addressed paths such as `processed_by_hash/{hash}.jpg` and may be shared by multiple image records.

## 2. Proposed changes

1. Replace the patient endpoint's soft-delete behavior with a coordinated hard-delete service.
2. Add `ON DELETE CASCADE` to `processing_jobs.visit_id`.
3. Lock the patient and its related records in a PostgreSQL transaction.
4. Refuse deletion with HTTP `409` while a BullMQ image-processing job is active.
5. Remove non-active retained BullMQ jobs before deleting their database records.
6. Collect MinIO objects from database URLs and from every visit prefix.
7. Commit the database deletion together with a durable MinIO-cleanup outbox record.
8. Retry MinIO cleanup idempotently instead of rolling the database back after a partial object deletion.
9. Serialize BullMQ job creation with patient deletion by creating `processing_jobs` before enqueue.
10. Protect `processed_by_hash` with a shared PostgreSQL advisory lock and a fresh reference check.
11. Warn users in the frontend that visits, images, annotations, and objects are permanently deleted.

## 3. Implementation

### Backend orchestration

`backend/src/services/patientDeletionService.js` now performs the deletion workflow:

1. Validate the patient ID.
2. Start a transaction and lock the patient with `FOR UPDATE`.
3. Load all visits, image URLs, annotation URLs, dependency counts, and processing jobs.
4. List MinIO objects below each `visits/{visitId}/` prefix to include replaced or orphaned visit files.
5. Normalize relative URLs, absolute URLs, and presigned URLs into MinIO object names.
6. Exclude visit-owned object names referenced outside the target patient.
7. Reject active or unverifiable jobs and remove non-active BullMQ jobs.
8. Insert a `storage_deletion_jobs` outbox record in the same transaction as the hard delete.
9. Hard-delete the patient and commit the PostgreSQL transaction.
10. Attempt MinIO cleanup immediately after commit; the background worker retries any partial or transient failure.
11. Recheck every `processed_by_hash` reference while holding the same advisory lock used by the image-processing writer.

The controller returns structured HTTP errors:

- `400 INVALID_PATIENT_ID`
- `404 PATIENT_NOT_FOUND`
- `409 PATIENT_PROCESSING_ACTIVE`
- `502 PATIENT_MINIO_LIST_FAILED`
- `503 PATIENT_QUEUE_CLEANUP_FAILED`

The endpoint returns `200` when storage cleanup finishes in the request and `202` when the database deletion is complete but the durable cleanup job is still pending.

The delete route now requires authentication because it permanently removes clinical data.

### Database

`init-db/009_cascade_processing_jobs_on_visit_delete.sql` changes the processing job foreign key to `ON DELETE CASCADE`. The migration is idempotent.

`init-db/010_create_storage_deletion_outbox.sql` adds the durable `storage_deletion_jobs` outbox and documents the new `creating` processing-job status. The outbox does not reference `patients`, so its retry data remains available after the patient row is hard-deleted.

For an existing database volume, apply it explicitly:

```powershell
docker exec -i nhakhoa-postgres psql -v ON_ERROR_STOP=1 -U postgres -d dental_db -f /docker-entrypoint-initdb.d/008_add_processing_jobs.sql
docker exec -i nhakhoa-postgres psql -v ON_ERROR_STOP=1 -U postgres -d dental_db -f /docker-entrypoint-initdb.d/009_cascade_processing_jobs_on_visit_delete.sql
docker exec -i nhakhoa-postgres psql -v ON_ERROR_STOP=1 -U postgres -d dental_db -f /docker-entrypoint-initdb.d/010_create_storage_deletion_outbox.sql
```

Adding the file alone does not migrate an existing volume because PostgreSQL's Docker initialization directory only runs for a new data directory.

### MinIO storage

`backend/src/services/storage.js` now provides:

- `extractObjectName()` for relative, absolute, and presigned URLs.
- `listFilesByPrefix()` for visit-level orphan cleanup.
- Deduplicated, batched `deleteFiles()` with a deletion count.

`backend/src/services/storageDeletionService.js` now:

- Claims cleanup jobs with `FOR UPDATE SKIP LOCKED` semantics.
- Retries the full idempotent object list after a partial MinIO failure.
- Reclaims stale `processing` jobs after five minutes.
- Takes `pg_advisory_xact_lock(hashtextextended(object_name, 0))` before deleting a content-addressed object.
- Rechecks current database references after acquiring the advisory lock.

`backend/src/workers/storageDeletionWorker.js` polls and retries cleanup jobs. It starts and stops with the existing image-processing worker.

`backend/src/services/processedImageReferenceService.js` uses the same advisory lock while ensuring a processed object exists and committing `images.url_processed`. This closes the race between a writer reusing a hash and garbage collection deleting that hash.

### BullMQ job creation

`ImageProcessingController` now locks the visit, inserts a `processing_jobs` row with status `creating`, commits it, and only then enqueues BullMQ. The database primary key is used as the BullMQ `jobId`, so the worker and database always address the same job. Patient deletion fails closed when a `creating`, `queued`, or `processing` database job cannot be verified in BullMQ.

### Frontend

The active patient list now:

- States how many visits will be removed.
- Explicitly warns that images, annotations, and MinIO data are permanently deleted.
- Disables the selected delete button while the request is running.
- Displays the backend success or error message.

## 4. Results

### Automated unit tests

```powershell
cd backend
npm run test:unit
```

Passed scenarios:

- Complete patient deletion while preserving a shared processed object.
- HTTP `409` and rollback when a BullMQ job is active.
- Database deletion remains committed while a failed MinIO cleanup stays retryable in the outbox.
- A partial MinIO failure retries the complete idempotent object list.
- Processing-job metadata is committed before BullMQ enqueue and uses the same job ID.
- Processed-image writers and cleanup use the same advisory lock.
- A fresh shared-object reference preserves the object during cleanup.
- Invalid patient ID rejected before opening a database connection.
- Relative, absolute, and presigned MinIO URL normalization.

Result on the branch based on `origin/dev`: `npm run test:unit` passed `12/12`, plus the existing subbox mapper checks. Full test discovery passed `15`, failed `0`, and skipped the one environment-gated integration test; that integration test was then enabled and run separately as described below.

### PostgreSQL and MinIO integration test

```powershell
$env:RUN_PATIENT_DELETE_INTEGRATION='true'
node --test src/services/patientDeletionService.integration.test.js
```

The fixture creates two patients and populates cases, case-doctors, visits, images, parent/child annotations, annotation history, subboxes, labels, validations, a processing job, visit-prefixed MinIO objects, and a processed object shared between both patients.

After porting to `origin/dev`, the integration test was run again against local PostgreSQL and MinIO. It verifies:

- Every target database row was removed through the cascade.
- The unrelated patient and its raw object remained.
- Raw, annotation, replaced/orphaned visit objects were removed.
- The processed object shared by the second patient remained.
- Deleting the final referencing patient subsequently removed the shared processed object.
- The cleanup outbox reached `completed` with the expected deleted and preserved counts.
- The fixture cleaned itself up after the test.

Current port result: `1 passed, 0 failed`.

### HTTP verification

The running backend was tested through the public workflow:

1. Log in as a local user.
2. Send authenticated `DELETE /api/patients/:id`.
3. Receive a successful response with deletion statistics.
4. Query PostgreSQL and confirm the patient row count is `0`.

### Build and static checks

- Backend syntax checks passed.
- `git diff --check` passed.
- Frontend production build passed with 160 modules transformed.
- `docker compose config --quiet` passed.
- Live database verification passed: `processing_jobs` and `storage_deletion_jobs` exist, and `processing_jobs_visit_id_fkey` reports `ON DELETE CASCADE`.
- Redis/BullMQ smoke test passed by enqueueing, reading, removing, and cleaning an isolated queue job.
- Backend startup connected successfully to local PostgreSQL, MinIO, and Redis; both workers started and graceful shutdown closed the worker, database pool, Redis connection, and HTTP server.
- HTTP smoke tests returned `401` without authentication, `404 PATIENT_NOT_FOUND` for an authenticated missing patient, and `200` for an authenticated disposable patient fixture; the fixture row was confirmed deleted.

## 5. Review of changes

### Files added

- `backend/src/config/queue.js`
- `backend/src/services/patientDeletionService.js`
- `backend/src/services/patientDeletionService.test.js`
- `backend/src/services/patientDeletionService.integration.test.js`
- `backend/src/services/storageDeletionService.js`
- `backend/src/services/storageDeletionService.test.js`
- `backend/src/services/processedImageReferenceService.js`
- `backend/src/services/processedImageReferenceService.test.js`
- `backend/src/workers/storageDeletionWorker.js`
- `backend/src/workers/imageProcessor.js`
- `backend/src/controllers/ImageProcessingController.test.js`
- `init-db/008_add_processing_jobs.sql`
- `init-db/009_cascade_processing_jobs_on_visit_delete.sql`
- `init-db/010_create_storage_deletion_outbox.sql`
- `docs/delete-patient-cascade-implementation.md`

### Files updated

- `backend/package-lock.json`
- `backend/package.json`
- `backend/src/controllers/PatientController.js`
- `backend/src/controllers/ImageProcessingController.js`
- `backend/src/models/Patient.js`
- `backend/src/routes/api.js`
- `backend/src/server.js`
- `backend/src/services/storage.js`
- `docker-compose.yml`
- `frontend/src/components/ImageUpload.jsx`
- `frontend/src/components/PatientList.jsx`
- `frontend/src/services/patientService.js`
- `frontend/src/services/imageService.js`
- `frontend/src/features/patients/hooks/usePatients.js`
- `frontend/src/features/patients/pages/PatientDetailPage.jsx`

### Transaction boundary after the F1 to F3 fixes

PostgreSQL and MinIO still cannot participate in one atomic transaction, so the implementation no longer pretends that a database rollback can restore deleted objects. The patient hard delete and the cleanup manifest commit atomically in PostgreSQL. MinIO cleanup happens afterward and is idempotently retried from the durable outbox. The database therefore cannot roll back into metadata that points to objects already removed by an earlier successful batch.

Content-addressed processed objects are scheduled on every relevant patient deletion, including when another patient currently references them. Cleanup takes the shared advisory lock and performs a fresh reference check. Concurrent deletions therefore cannot permanently preserve an orphan merely because both requests saw the other reference before committing.

Abandoned presigned uploads that were never confirmed and are neither stored in database metadata nor placed below a visit prefix cannot be associated safely with a patient. Those objects require a separate age-based orphan cleanup process.
