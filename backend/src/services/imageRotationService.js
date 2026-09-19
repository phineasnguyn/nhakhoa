const { randomUUID } = require('node:crypto');
const { validBox } = require('./imageOverlayService');
const { overlayReady, presentImage } = require('./imagePresentation');

function rotateBox([x, y, w, h], width, height, angle) {
  if (angle === 90) return [height-y-h, x, h, w];
  if (angle === 180) return [width-x-w, height-y-h, w, h];
  if (angle === 270) return [y, width-x-w, h, w];
  throw new Error('Invalid rotation');
}
function rotateRegion(region, angle) {
  const ring = ['top', 'right', 'bottom', 'left'];
  const index = ring.indexOf(region);
  return index < 0 ? region : ring[(index + angle/90) % 4];
}
function createImageRotationService(dependencies = {}) {
  const pool = dependencies.pool || require('../config/database').pool;
  const storage = dependencies.storage || require('./storage');
  const sharp = dependencies.sharp || require('sharp');
  const snapshotService = dependencies.overlay || require('./imageOverlayService').createImageOverlayService(dependencies);
  async function rotate(imageId, angle, expectedRevision, expectedAnnotations) {
    if (![90,180,270].includes(angle)) throw Object.assign(new Error('Invalid rotation'), { statusCode: 400 });
    const { image, rows } = await snapshotService.snapshot(imageId);
    if (expectedRevision == null || expectedAnnotations == null) throw Object.assign(new Error('Reload image before rotating'), { statusCode: 428 });
    if (String(image.image_revision) !== String(expectedRevision) || String(image.annotation_revision) !== String(expectedAnnotations)) {
      throw Object.assign(new Error('Image changed; reload before rotating'), { statusCode: 409 });
    }
    const source = await storage.downloadFile(storage.extractObjectName(image.url));
    const metadata = await sharp(source).metadata();
    if ((metadata.orientation && metadata.orientation !== 1) || !metadata.width || !metadata.height
      || (rows.length && (image.width !== metadata.width || image.height !== metadata.height))
      || rows.some(a => !validBox(a.bbox, metadata.width, metadata.height))) {
      throw Object.assign(new Error('Image orientation or annotation dimensions need review'), { statusCode: 409 });
    }
    const rotated = await sharp(source).rotate(angle).jpeg({ quality: 95 }).toBuffer();
    const nextWidth = angle === 180 ? metadata.width : metadata.height;
    const nextHeight = angle === 180 ? metadata.height : metadata.width;
    const objectName = `visits/${image.visit_id}/raw_revision_${imageId}_${randomUUID()}.jpg`;
    const uploaded = await storage.uploadFromBuffer(rotated, objectName, 'image/jpeg');
    if (!uploaded.success) throw new Error('Could not store rotated image');
    let client;
    let commitAttempted = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const locked = (await client.query(
        `SELECT i.* FROM images i JOIN visits v ON v.id=i.visit_id JOIN patients p ON p.id=v.patient_id
         WHERE i.id=$1 AND i.deleted_at IS NULL AND v.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF p,v,i`, [imageId])).rows[0];
      if (!locked || String(locked.image_revision) !== String(expectedRevision) || String(locked.annotation_revision) !== String(expectedAnnotations)) {
        throw Object.assign(new Error('Image changed while rotating'), { statusCode: 409 });
      }
      await client.query(
        'INSERT INTO image_source_history(image_id,source_url,image_snapshot,annotations_snapshot) VALUES ($1,$2,$3::jsonb,$4::jsonb)',
        [imageId, image.url, JSON.stringify(image), JSON.stringify(rows)]);
      await client.query('UPDATE images SET url=$2,width=$3,height=$4 WHERE id=$1', [imageId, uploaded.url, nextWidth, nextHeight]);
      // Clear only canonical positions inside this transaction before permuting
      // them, otherwise the existing unique parent/region index rejects swaps.
      await client.query(`UPDATE image_annotations SET subbox_region=NULL
        WHERE image_id=$1 AND subbox_region IN ('top','right','bottom','left')`, [imageId]);
      for (const row of rows) {
        await client.query('UPDATE image_annotations SET bbox=$2::jsonb,subbox_region=$3 WHERE id=$1',
          [row.id, JSON.stringify(rotateBox(row.bbox, metadata.width, metadata.height, angle)), rotateRegion(row.subbox_region, angle)]);
      }
      if (overlayReady(image)) await client.query(
        "UPDATE images SET processed_image_revision=image_revision,overlay_schema_version=1,processing_status='completed',overlay_review_reason=NULL WHERE id=$1", [imageId]);
      const result = (await client.query('SELECT * FROM images WHERE id=$1', [imageId])).rows[0];
      commitAttempted = true;
      await client.query('COMMIT');
      return presentImage(result);
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {});
      // A lost COMMIT response may already have committed the new reference.
      // Leave uncertain uploads for an inventory review, never delete live bytes.
      if (!commitAttempted) await storage.deleteFile(objectName).catch(() => {});
      throw error;
    } finally { client?.release(); }
  }
  return { rotate };
}
module.exports = { rotateBox, rotateRegion, createImageRotationService };
