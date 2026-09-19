BEGIN;

CREATE TABLE IF NOT EXISTS storage_deletion_jobs (
    id BIGSERIAL PRIMARY KEY,
    patient_id INTEGER NOT NULL,
    immediate_object_names JSONB NOT NULL DEFAULT '[]'::jsonb,
    shared_object_names JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    deleted_count INTEGER NOT NULL DEFAULT 0,
    preserved_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_at TIMESTAMP WITHOUT TIME ZONE,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITHOUT TIME ZONE,
    CONSTRAINT storage_deletion_jobs_status_check
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    CONSTRAINT storage_deletion_jobs_immediate_objects_array_check
        CHECK (jsonb_typeof(immediate_object_names) = 'array'),
    CONSTRAINT storage_deletion_jobs_shared_objects_array_check
        CHECK (jsonb_typeof(shared_object_names) = 'array')
);

-- The cleanup outbox stores technical identifiers only; do not retain patient PII.
ALTER TABLE storage_deletion_jobs
    DROP COLUMN IF EXISTS patient_name;

CREATE INDEX IF NOT EXISTS idx_storage_deletion_jobs_pending
    ON storage_deletion_jobs (next_attempt_at, id)
    WHERE status IN ('pending', 'failed', 'processing');

COMMENT ON TABLE storage_deletion_jobs IS
    'Transactional outbox for retryable MinIO cleanup after database records are deleted';

COMMENT ON COLUMN storage_deletion_jobs.shared_object_names IS
    'Content-addressed objects that require an advisory lock and a fresh reference check before deletion';

COMMENT ON COLUMN processing_jobs.status IS
    'Status: creating, queued, processing, completed, failed';

COMMIT;
