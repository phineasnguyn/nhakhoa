const { overlayReady, OVERLAY_SCHEMA_VERSION } = require('./imagePresentation');

const isBracket = a => Number(a.category_id) === 21 || /^(brace|bracket)$/i.test(a.category_name || '');
const boxOf = a => typeof a.bbox === 'string' ? JSON.parse(a.bbox) : a.bbox;
function validBox(box, width, height) {
  return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)
    && box[0] >= 0 && box[1] >= 0 && box[2] > 0 && box[3] > 0
    && box[0] + box[2] <= width + .01 && box[1] + box[3] <= height + .01;
}
function contained(child, parent) {
  return child[0] >= parent[0] - .01 && child[1] >= parent[1] - .01
    && child[0] + child[2] <= parent[0] + parent[2] + .01
    && child[1] + child[3] <= parent[1] + parent[3] + .01;
}
class OverlayReviewError extends Error {
  constructor(message) { super(message); this.code = 'OVERLAY_REVIEW_REQUIRED'; }
}

function planExistingAnnotations(image, rows) {
  if (!(image.width > 0 && image.height > 0)) throw new OverlayReviewError('missing_dimensions');
  if (rows.length === 0 && !image.annotations_verified_empty) throw new OverlayReviewError('missing_annotations');
  for (const a of rows) {
    if (!validBox(boxOf(a), image.width, image.height)) throw new OverlayReviewError('invalid_bbox');
  }
  const parents = rows.filter(a => !a.parent_annotation_id);
  const teeth = parents.filter(a => !isBracket(a));
  const brackets = parents.filter(isBracket);
  const parentMap = new Map(teeth.map(a => [a.id, a]));
  for (const child of rows.filter(a => a.parent_annotation_id)) {
    const parent = parentMap.get(child.parent_annotation_id);
    if (!parent || !contained(boxOf(child), boxOf(parent))) throw new OverlayReviewError('invalid_subbox_parent');
  }
  if (!teeth.length && rows.length && !image.annotations_verified_empty) throw new OverlayReviewError('missing_teeth');
  const missing = [];
  for (const tooth of teeth) {
    const children = rows.filter(a => a.parent_annotation_id === tooth.id);
    if (!children.length) missing.push(tooth);
    else if (children.length !== 4 || children.some(a => !a.subbox_region)
      || new Set(children.map(a => a.subbox_region)).size !== 4) {
      throw new OverlayReviewError('incomplete_or_ambiguous_existing_regions');
    }
  }
  return { missing, brackets };
}

function createImageOverlayService(dependencies = {}) {
  const pool = dependencies.pool || require('../config/database').pool;
  const processing = dependencies.processing || require('./imageProcessingService');
  const storage = dependencies.storage || require('./storage');

  async function snapshot(imageId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const images = await client.query(
        `SELECT i.* FROM images i JOIN visits v ON v.id=i.visit_id JOIN patients p ON p.id=v.patient_id
         WHERE i.id=$1 AND i.deleted_at IS NULL AND v.deleted_at IS NULL AND p.deleted_at IS NULL`, [imageId]);
      const image = images.rows[0];
      if (!image) throw new OverlayReviewError('image_unavailable');
      const rows = (await client.query('SELECT * FROM image_annotations WHERE image_id=$1 ORDER BY id', [imageId])).rows;
      await client.query('COMMIT');
      return { image, rows };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async function processImage(imageId) {
    let { image, rows } = await snapshot(imageId);
    if (overlayReady(image)) return { imageId, status: 'completed', reused: true };
    if (!(image.width > 0 && image.height > 0)) {
      const sharp = dependencies.sharp || require('sharp');
      const buffer = await storage.downloadFile(storage.extractObjectName(image.url));
      const metadata = await sharp(buffer).metadata();
      if (!metadata.width || !metadata.height || (metadata.orientation && metadata.orientation !== 1)) {
        throw new OverlayReviewError('unverified_orientation');
      }
      const saved = await pool.query(
        `UPDATE images SET width=$1,height=$2,
         legacy_image_revision=CASE WHEN legacy_image_revision=image_revision THEN image_revision+1 ELSE legacy_image_revision END
         WHERE id=$3 AND image_revision=$4
         AND annotation_revision=$5 RETURNING id`,
        [metadata.width, metadata.height, imageId, image.image_revision, image.annotation_revision]);
      if (!saved.rows.length) throw Object.assign(new Error('Image changed while reading metadata'), { code: 'STALE_INPUT' });
      ({ image, rows } = await snapshot(imageId));
    }
    const { missing, brackets } = planExistingAnnotations(image, rows);
    let regions = [];
    if (missing.length) {
      const result = await processing.computeOverlay({
        image_id: imageId, image_revision: image.image_revision,
        width: image.width, height: image.height,
        teeth: missing.map(a => ({ id: a.id, bbox: boxOf(a) })),
        brackets: brackets.map(a => ({ id: a.id, bbox: boxOf(a) })),
      });
      if (result.issues?.length) throw new OverlayReviewError(result.issues.map(i => `${i.parent_id}:${i.reason}`).join('; '));
      regions = result.regions;
      if (result.schema_version !== OVERLAY_SCHEMA_VERSION || !Array.isArray(regions)) throw new OverlayReviewError('invalid_geometry_response');
      const expected = new Map(missing.map(a => [a.id, a]));
      for (const region of regions) {
        const parent = expected.get(region.parent_id);
        if (!parent || !['top','bottom','left','right'].includes(region.region)
          || !validBox(region.bbox, image.width, image.height) || !contained(region.bbox, boxOf(parent))) {
          throw new OverlayReviewError('invalid_generated_region');
        }
      }
      for (const parent of missing) {
        const group = regions.filter(r => r.parent_id === parent.id);
        if (group.length !== 4 || new Set(group.map(r => r.region)).size !== 4) throw new OverlayReviewError('incomplete_geometry_response');
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Same parent -> visit -> image lock order as patient deletion.
      const live = await client.query(
        `SELECT i.* FROM images i JOIN visits v ON v.id=i.visit_id JOIN patients p ON p.id=v.patient_id
         WHERE i.id=$1 AND i.deleted_at IS NULL AND v.deleted_at IS NULL AND p.deleted_at IS NULL
         FOR UPDATE OF p,v,i`, [imageId]);
      const current = live.rows[0];
      if (!current || String(current.image_revision) !== String(image.image_revision)
        || String(current.annotation_revision) !== String(image.annotation_revision)) {
        throw Object.assign(new Error('Image or annotations changed during processing'), { code: 'STALE_INPUT' });
      }
      for (const region of regions) {
        const parent = missing.find(a => a.id === region.parent_id);
        await client.query(
          `INSERT INTO image_annotations (image_id,coco_image_id,category_id,category_name,bbox,area,
           parent_annotation_id,subbox_region,source_type,plaque_status,predicted_plaque)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$4,'overlay_geometry',1,NULL)`,
          [imageId, parent.coco_image_id, parent.category_id, region.region, JSON.stringify(region.bbox),
            region.bbox[2] * region.bbox[3], parent.id]);
      }
      await client.query(
        `UPDATE images SET processing_status='completed',processed_at=CURRENT_TIMESTAMP,
         processed_image_revision=image_revision,overlay_schema_version=$2,overlay_review_reason=NULL,
         annotation_count=(SELECT count(*) FROM image_annotations WHERE image_id=$1),
         has_annotations=EXISTS(SELECT 1 FROM image_annotations WHERE image_id=$1) WHERE id=$1`,
        [imageId, OVERLAY_SCHEMA_VERSION]);
      await client.query('COMMIT');
      return { imageId, status: 'completed', generatedRegions: regions.length };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  return { processImage, snapshot };
}

module.exports = { createImageOverlayService, planExistingAnnotations, validBox, contained, OverlayReviewError };
