const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

// The runner supplies a disposable database, bucket and Redis; never load .env here.
test('overlay, retry, rotations and storage audit on isolated PostgreSQL/MinIO/Redis/Python',
  { skip: process.env.RUN_IMAGE_OVERLAY_INTEGRATION !== 'true', timeout: 90000 }, async()=>{
  assert.match(process.env.DB_NAME, /^overlay_test_/);
  assert.match(process.env.MINIO_BUCKET, /^overlay-test-/);
  assert.equal(process.env.DB_HOST,'127.0.0.1');
  const db = require('../config/database');
  const storage = require('./storage');
  const minio = require('../config/minio');
  const sharp = require('sharp');
  const { createImageOverlayService } = require('./imageOverlayService');
  const { createImageRotationService } = require('./imageRotationService');
  const { auditImageStorage } = require('./imageStorageAudit');
  const { presentImage } = require('./imagePresentation');
  const { imageProcessingQueue: queue, connection } = require('../config/queue');
  const { startWorker,stopWorker } = require('../workers/imageProcessor');
  const { QueueEvents } = require('bullmq');
  const events = new QueueEvents('image-processing',{connection});
  const objects = async()=>{
    const list=[];
    const stream=minio.listObjectsV2(process.env.MINIO_BUCKET,'',true);
    stream.on('data',v=>list.push(v)); await once(stream,'end');
    return list.map(v=>({name:v.name,size:v.size}));
  };
  const getImage = async (id=1)=>(await db.query('SELECT * FROM images WHERE id=$1',[id])).rows[0];
  try {
    await storage.ensureBucket();
    const raw=await sharp({create:{width:400,height:600,channels:3,background:'#e8d8c8'}}).jpeg().toBuffer();
    await storage.uploadFromBuffer(raw,'visits/1/raw.jpg','image/jpeg');
    await storage.uploadFromBuffer(raw,'processed/legacy.jpg','image/jpeg');
    await db.query("INSERT INTO patients(id,name) VALUES(1,'Overlay synthetic fixture')");
    await db.query("INSERT INTO visits(id,patient_id,visit_date) VALUES(1,1,CURRENT_DATE)");
    await db.query(`INSERT INTO images(id,visit_id,url,url_processed,image_category,width,height)
      VALUES(1,1,$1,$2,'raw',400,600),(2,1,$1,$2,'raw',400,600)`,
      [storage.getFileUrl('visits/1/raw.jpg'),storage.getFileUrl('processed/legacy.jpg')]);
    await db.query(`INSERT INTO image_annotations(id,image_id,coco_image_id,category_id,category_name,bbox)
      VALUES(10,1,1,1,'11','[20,20,300,500]'),(11,1,1,21,'brace','[120,220,80,80]')`);
    await db.query("SELECT setval(pg_get_serial_sequence('image_annotations','id'),100)");
    const before=await objects();
    const service=createImageOverlayService();
    const first=await service.processImage(1);
    assert.equal(first.generatedRegions,4);
    assert.deepEqual(await objects(),before,'metadata processing creates zero MinIO objects');
    const children=(await db.query('SELECT * FROM image_annotations WHERE parent_annotation_id=10 ORDER BY id')).rows;
    assert.equal(children.length,4); assert.ok(children.every(c=>c.predicted_plaque===null));
    const label=children[0];
    const beforeLabel=await getImage();
    await db.query('UPDATE image_annotations SET plaque_status=0 WHERE id=$1',[label.id]);
    const labeled=await getImage();
    assert.ok(Number(labeled.annotation_revision)>Number(beforeLabel.annotation_revision));
    assert.equal(labeled.image_revision,beforeLabel.image_revision);
    assert.equal(presentImage(labeled).render_mode,'overlay');
    assert.equal((await service.processImage(1)).reused,true);
    assert.equal((await db.query('SELECT plaque_status FROM image_annotations WHERE id=$1',[label.id])).rows[0].plaque_status,0);
    assert.deepEqual(await objects(),before);

    // A label written while Python computes makes the processing snapshot stale.
    await db.query("UPDATE image_annotations SET bbox='[21,20,299,500]' WHERE id=10");
    await db.query('DELETE FROM image_annotations WHERE parent_annotation_id=10');
    const raced=createImageOverlayService({processing:{computeOverlay:async payload=>{
      const result=await require('./imageProcessingService').computeOverlay(payload);
      await db.query('UPDATE image_annotations SET plaque_status=0 WHERE id=10');
      return result;
    }}});
    await assert.rejects(raced.processImage(1),{code:'STALE_INPUT'});
    assert.equal((await db.query('SELECT count(*)::int AS n FROM image_annotations WHERE parent_annotation_id=10')).rows[0].n,0);
    await service.processImage(1);
    const ids=(await db.query('SELECT id,plaque_status FROM image_annotations WHERE image_id=1 ORDER BY id')).rows;
    const rotation=createImageRotationService();
    for(const angle of [90,180,270]) {
      const old=await getImage();
      const result=await rotation.rotate(1,angle,old.image_revision,old.annotation_revision);
      assert.equal(result.width,angle===180?old.width:old.height);
      assert.equal(result.height,angle===180?old.height:old.width);
      assert.equal(result.render_mode,'overlay');
      assert.deepEqual((await db.query('SELECT id,plaque_status FROM image_annotations WHERE image_id=1 ORDER BY id')).rows,ids);
      assert.ok(await storage.statFile(storage.extractObjectName(old.url)),'previous source retained');
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM image_source_history')).rows[0].n,3);

    // The second legacy image lacks annotations: job is partial, never fake success.
    await events.waitUntilReady();
    startWorker();
    const record=(await db.query("INSERT INTO processing_jobs(visit_id,status) VALUES(1,'creating') RETURNING id")).rows[0];
    const job=await queue.add('process-images',{visitId:1,userId:null,processingJobId:record.id},{jobId:`image-${record.id}`});
    const result=await job.waitUntilFinished(events,30000);
    assert.equal(result.status,'partial'); assert.equal(result.processedCount,1);
    assert.equal((await db.query('SELECT status FROM processing_jobs WHERE id=$1',[record.id])).rows[0].status,'partial');
    assert.ok(Buffer.byteLength(JSON.stringify((await queue.getJob(job.id)).toJSON()))<10000,'Redis contains metadata only');

    // Exercise an actual delayed BullMQ retry after one transient Python failure.
    await db.query('DELETE FROM image_annotations WHERE image_id=1 AND parent_annotation_id IS NOT NULL');
    const processing=require('./imageProcessingService');
    const original=processing.computeOverlay.bind(processing);
    let calls=0;
    processing.computeOverlay=async payload=>{ if(++calls===1) throw Error('Injected transient geometry outage'); return original(payload); };
    try {
      const retryRecord=(await db.query("INSERT INTO processing_jobs(visit_id,status) VALUES(1,'creating') RETURNING id")).rows[0];
      const retry=await queue.add('process-images',{visitId:1,userId:null,processingJobId:retryRecord.id},
        {jobId:`image-${retryRecord.id}`,attempts:2,backoff:{type:'fixed',delay:100}});
      const retried=await retry.waitUntilFinished(events,30000);
      assert.equal(retried.status,'partial'); assert.equal(calls,2);
      assert.equal((await queue.getJob(retry.id)).attemptsMade,2);
    } finally { processing.computeOverlay=original; }
    const audit=await auditImageStorage({pool:db.pool,storage,identity:{database:process.env.DB_NAME}});
    assert.equal(audit.candidateBytes,0,'history and unready consumer protect the shared legacy object');
    assert.equal(audit.objects.length,1);
    console.log(JSON.stringify({initialObjects:before.length,objectsAfterProcessing:before.length,
      initialBytes:before.reduce((n,o)=>n+o.size,0),rotationHistory:3,jobStatus:result.status,
      rssNode:process.memoryUsage().rss}));
  } finally {
    await stopWorker(); await events.close(); await queue.close(); await connection.quit(); await db.pool.end();
  }
});
