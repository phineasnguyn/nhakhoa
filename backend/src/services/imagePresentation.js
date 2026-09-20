const OVERLAY_SCHEMA_VERSION = 1;

function overlayReady(image) {
  return image.processing_status === 'completed'
    && Number(image.overlay_schema_version) === OVERLAY_SCHEMA_VERSION
    && image.processed_image_revision != null
    && String(image.processed_image_revision) === String(image.image_revision);
}

function presentImage(image) {
  return {
    ...image,
    render_mode: overlayReady(image) ? 'overlay'
      : image.url_processed && String(image.legacy_image_revision ?? 1) === String(image.image_revision ?? 1) ? 'legacy_bitmap' : 'raw',
    overlay_ready: overlayReady(image),
  };
}

function groupAnnotations(rows) {
  const parents = new Map();
  for (const row of rows) {
    if (row.parent_annotation_id) continue;
    parents.set(row.id, {
      annotation_id: row.id, category_id: row.category_id, category_name: row.category_name,
      kind: Number(row.category_id) === 21 || /^(brace|bracket)$/i.test(row.category_name || '') ? 'bracket' : 'tooth',
      bbox: typeof row.bbox === 'string' ? JSON.parse(row.bbox) : row.bbox,
      source_type: row.source_type, subboxes: [],
    });
  }
  for (const row of rows) {
    if (!row.parent_annotation_id) continue;
    parents.get(row.parent_annotation_id)?.subboxes.push({
      subbox_id: row.id, region: row.subbox_region, bbox: typeof row.bbox === 'string' ? JSON.parse(row.bbox) : row.bbox,
      plaque_status: row.plaque_status, predicted_plaque: row.predicted_plaque,
      annotated_by: row.annotated_by ? { id: row.annotated_by, name: row.annotated_by_name } : null,
      annotated_at: row.annotated_at, source_type: row.source_type,
    });
  }
  return [...parents.values()];
}

module.exports = { overlayReady, presentImage, groupAnnotations, OVERLAY_SCHEMA_VERSION };
