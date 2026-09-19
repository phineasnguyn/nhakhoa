-- Processing job history belongs to a visit and must be removed with it.
-- This script is idempotent so it can also be applied to an existing database.
ALTER TABLE processing_jobs
    DROP CONSTRAINT IF EXISTS processing_jobs_visit_id_fkey;

ALTER TABLE processing_jobs
    ADD CONSTRAINT processing_jobs_visit_id_fkey
        FOREIGN KEY (visit_id)
        REFERENCES visits(id)
        ON DELETE CASCADE;
