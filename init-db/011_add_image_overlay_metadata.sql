-- Additive migration: legacy processed URLs remain available for rollback.
ALTER TABLE images ADD COLUMN IF NOT EXISTS image_revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE images ADD COLUMN IF NOT EXISTS annotation_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN IF NOT EXISTS processed_image_revision BIGINT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS overlay_schema_version INTEGER;
ALTER TABLE images ADD COLUMN IF NOT EXISTS overlay_review_reason TEXT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS annotations_verified_empty BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE images ADD COLUMN IF NOT EXISTS legacy_image_revision BIGINT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS image_source_history (
  id BIGSERIAL PRIMARY KEY,
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  image_snapshot JSONB NOT NULL,
  annotations_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION image_content_revision() RETURNS trigger AS $$
BEGIN
  IF (NEW.url, NEW.width, NEW.height) IS DISTINCT FROM (OLD.url, OLD.width, OLD.height) THEN
    NEW.image_revision := OLD.image_revision + 1;
    NEW.processed_image_revision := NULL;
    NEW.overlay_schema_version := NULL;
    NEW.overlay_review_reason := NULL;
    NEW.processing_status := 'pending';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS images_content_revision ON images;
CREATE TRIGGER images_content_revision BEFORE UPDATE ON images
FOR EACH ROW EXECUTE FUNCTION image_content_revision();

-- Include imports and legacy writers, not only the HTTP label controller.
CREATE OR REPLACE FUNCTION image_annotation_revision() RETURNS trigger AS $$
DECLARE
  target_id INTEGER;
  geometry_changed BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN target_id := OLD.image_id;
  ELSE target_id := NEW.image_id; END IF;
  geometry_changed := TG_OP <> 'UPDATE';
  IF TG_OP = 'UPDATE' THEN
    geometry_changed := (NEW.bbox, NEW.parent_annotation_id, NEW.image_id, NEW.category_id, NEW.subbox_region)
      IS DISTINCT FROM (OLD.bbox, OLD.parent_annotation_id, OLD.image_id, OLD.category_id, OLD.subbox_region);
  END IF;
  UPDATE images SET annotation_revision = annotation_revision + 1,
    processed_image_revision = CASE WHEN geometry_changed THEN NULL ELSE processed_image_revision END,
    overlay_schema_version = CASE WHEN geometry_changed THEN NULL ELSE overlay_schema_version END,
    processing_status = CASE WHEN geometry_changed THEN 'pending' ELSE processing_status END
  WHERE id = target_id;
  IF TG_OP = 'UPDATE' AND OLD.image_id IS DISTINCT FROM NEW.image_id THEN
    UPDATE images SET annotation_revision = annotation_revision + 1,
      processed_image_revision = NULL, overlay_schema_version = NULL, processing_status = 'pending'
    WHERE id = OLD.image_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS annotations_image_revision ON image_annotations;
CREATE TRIGGER annotations_image_revision AFTER INSERT OR UPDATE OR DELETE ON image_annotations
FOR EACH ROW EXECUTE FUNCTION image_annotation_revision();
