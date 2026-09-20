const { overlayReady } = require('./imagePresentation');

// Read-only inventory. Never remove legacy references as a side effect of inspection.
async function auditImageStorage({ pool, storage, identity, now = new Date() }) {
  const client = await pool.connect();
  let images, history, visits;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    images = (await client.query('SELECT * FROM images ORDER BY id')).rows;
    history = (await client.query('SELECT source_url,image_snapshot FROM image_source_history')).rows;
    visits = (await client.query('SELECT annotation_file_url FROM visits WHERE annotation_file_url IS NOT NULL')).rows;
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const key = storage.extractObjectName;
  const protectedKeys = new Set([
    ...images.map(i=>key(i.url)), ...visits.map(v=>key(v.annotation_file_url)),
    ...history.flatMap(h=>[key(h.source_url),key(h.image_snapshot.url_processed)]),
  ].filter(Boolean));
  const groups = new Map();
  for (const image of images) {
    const objectName = key(image.url_processed);
    if (!objectName) continue;
    if (!groups.has(objectName)) groups.set(objectName,[]);
    groups.get(objectName).push(image);
  }
  const objects = [];
  for (const [objectName, refs] of groups) {
    const reasons = [];
    if (protectedKeys.has(objectName)) reasons.push('source_annotation_or_history_reference');
    if (refs.some(i=>!overlayReady(i))) reasons.push('legacy_consumer_or_unverified_overlay');
    if (refs.some(i=>i.deleted_at)) reasons.push('soft_deleted_reference');
    let info;
    try { info = await storage.statFile(objectName); }
    catch (e) { reasons.push(e.code === 'NoSuchKey' || e.code === 'NotFound' ? 'object_missing' : 'stat_failed'); }
    objects.push({ objectName, size: info?.size ?? null, etag: info?.etag ?? null,
      versionId: info?.versionId ?? null, status: reasons.length ? 'preserve' : 'candidate_for_review', reasons,
      references: refs.map(i=>({imageId:i.id,imageRevision:i.image_revision,annotationRevision:i.annotation_revision,
        legacyUrl:i.url_processed,processedAt:i.processed_at,renderReady:overlayReady(i)})) });
  }
  return { schemaVersion:1, mode:'dry-run', createdAt:now.toISOString(), identity,
    requirements:['Confirm every DB/app sharing the bucket', 'Drain all writers during maintenance',
      'Verify previews and rollback backup', 'Wait the retention period', 'Recheck revisions, references and ETags before removal',
      'Account for bucket versioning; markers are not reclaimed bytes'],
    imageCount:images.length, overlayCount:images.filter(overlayReady).length,
    legacyReferenceCount:[...groups.values()].reduce((n,refs)=>n+refs.length,0),
    candidateBytes:objects.filter(o=>o.status==='candidate_for_review').reduce((n,o)=>n+o.size,0), objects };
}
module.exports = { auditImageStorage };
