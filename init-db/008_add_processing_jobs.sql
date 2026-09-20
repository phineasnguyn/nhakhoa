CREATE TABLE IF NOT EXISTS processing_jobs (
    id SERIAL PRIMARY KEY,
    visit_id INTEGER NOT NULL REFERENCES visits(id),
    bullmq_job_id VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'queued',
    progress INTEGER DEFAULT 0,
    total_images INTEGER DEFAULT 0,
    processed_images INTEGER DEFAULT 0,
    error_message TEXT,
    result_data JSONB,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP WITHOUT TIME ZONE,
    completed_at TIMESTAMP WITHOUT TIME ZONE,
    updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE processing_jobs IS 'Tracks async image processing jobs';
COMMENT ON COLUMN processing_jobs.bullmq_job_id IS 'BullMQ job ID for status lookup';
COMMENT ON COLUMN processing_jobs.status IS 'Status: creating, queued, processing, completed, failed';
COMMENT ON COLUMN processing_jobs.progress IS 'Overall progress percentage (0-100)';
COMMENT ON COLUMN processing_jobs.total_images IS 'Total number of images to process';
COMMENT ON COLUMN processing_jobs.processed_images IS 'Number of images processed so far';

CREATE INDEX IF NOT EXISTS idx_processing_jobs_visit_id ON processing_jobs(visit_id);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_status ON processing_jobs(status) WHERE status IN ('queued', 'processing');
CREATE INDEX IF NOT EXISTS idx_processing_jobs_bullmq_job_id ON processing_jobs(bullmq_job_id);
