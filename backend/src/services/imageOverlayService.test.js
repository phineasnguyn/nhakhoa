const test = require('node:test');
const assert = require('node:assert/strict');
const { createImageOverlayService, planExistingAnnotations } = require('./imageOverlayService');
const { presentImage } = require('./imagePresentation');
const { rotateBox, rotateRegion, createImageRotationService } = require('./imageRotationService');

const image = { id: 1, visit_id: 1, width: 400, height: 600, image_revision: '2', annotation_revision: '8', url: '/b/raw.jpg' };
const parent = { id: 10, coco_image_id: 1, category_id: 1, bbox: [0,0,200,300] };
const regions = ['top','bottom','left','right'].map((region,i) => ({ parent_id: 10, region, bbox: [i*10,0,10,20] }));
function fixture({ changed = false, insertError = false } = {}) {
  const events = [];
  const client = { release() {}, async query(sql) {
    events.push(sql);
    if (sql.includes('SELECT i.*')) return { rows: [{ ...image, annotation_revision: sql.includes('FOR UPDATE') && changed ? '9' : '8' }] };
    if (sql.includes('SELECT * FROM image_annotations')) return { rows: [parent] };
    if (insertError && sql.includes('INSERT INTO image_annotations')) throw Error('DB unavailable');
    return { rows: [] };
  } };
  const service = createImageOverlayService({ pool: { connect: async () => client },
    processing: { computeOverlay: async () => ({ schema_version: 1, regions }) }, storage: {} });
  return { service, events };
}

test('missing annotations are not a negative result; explicitly verified empty is valid', () => {
  assert.throws(() => planExistingAnnotations(image, []), /missing_annotations/);
  assert.deepEqual(planExistingAnnotations({ ...image, annotations_verified_empty: true }, []), { missing: [], brackets: [] });
});
test('existing YOLO regions and labels remain untouched; incomplete groups are review', () => {
  const children = regions.map((r,i) => ({ id: i+20, parent_annotation_id: 10, bbox: r.bbox, subbox_region: r.region, plaque_status: i%2 }));
  const before = JSON.stringify(children);
  assert.equal(planExistingAnnotations(image, [parent, ...children]).missing.length, 0);
  assert.equal(JSON.stringify(children), before);
  assert.throws(() => planExistingAnnotations(image, [parent, ...children.slice(1)]), /incomplete/);
});
test('stale annotations cannot commit generated geometry', async () => {
  const { service, events } = fixture({ changed: true });
  await assert.rejects(service.processImage(1), { code: 'STALE_INPUT' });
  assert.ok(events.includes('ROLLBACK'));
  assert.ok(!events.some(s => s.includes('INSERT INTO image_annotations')));
});
test('a failed annotation write never marks the image completed', async () => {
  const { service, events } = fixture({ insertError: true });
  await assert.rejects(service.processImage(1), /DB unavailable/);
  assert.ok(events.includes('ROLLBACK'));
  assert.ok(!events.some(s => s.includes("SET processing_status='completed'")));
});
test('overlay rendering requires exact source revision; legacy invalid after source replacement', () => {
  const ready = { ...image, processing_status: 'completed', processed_image_revision: '2', overlay_schema_version: 1 };
  assert.equal(presentImage(ready).render_mode, 'overlay');
  assert.equal(presentImage({ ...ready, image_revision: '3' }).render_mode, 'raw');
  assert.equal(presentImage({ url_processed: '/old' }).render_mode, 'legacy_bitmap');
});
test('rotation preserves all corners and region identity across a full turn', () => {
  assert.deepEqual(rotateBox([10,20,30,40],100,200,90), [140,10,40,30]);
  assert.deepEqual(rotateBox([10,20,30,40],100,200,180), [60,140,30,40]);
  assert.deepEqual(rotateBox([10,20,30,40],100,200,270), [20,60,40,30]);
  assert.equal(rotateRegion('top',90),'right');
  assert.equal(rotateRegion('top_left',90),'top_left');
});
test('uncertain COMMIT must not delete an uploaded source that may be live', async () => {
  let deleted = false;
  const client = { release() {}, async query(sql) {
    if (sql === 'COMMIT') throw Error('Lost commit response');
    return { rows: [image] };
  } };
  const service = createImageRotationService({ pool: { connect: async () => client },
    overlay: { snapshot: async () => ({ image, rows: [] }) },
    storage: { extractObjectName: x=>x, downloadFile: async()=>Buffer.from('raw'),
      uploadFromBuffer: async()=>({success:true,url:'/new'}), deleteFile: async()=>{deleted=true;} },
    sharp: () => ({ metadata: async()=>({width:400,height:600}), rotate() {return this;}, jpeg() {return this;}, toBuffer: async()=>Buffer.from('rotated') }) });
  await assert.rejects(service.rotate(1,90,'2','8'), /Lost commit response/);
  assert.equal(deleted,false);
});
