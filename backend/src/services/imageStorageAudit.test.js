const test = require('node:test');
const assert = require('node:assert/strict');
const { auditImageStorage } = require('./imageStorageAudit');

test('dry-run deduplicates legacy objects and preserves unready, soft-deleted and history references', async()=>{
  const ready = { processing_status:'completed',image_revision:1,processed_image_revision:1,overlay_schema_version:1 };
  const images = [
    {...ready,id:1,url:'raw1',url_processed:'shared'},
    {...ready,id:2,url:'raw2',url_processed:'shared'},
    {...ready,id:3,url:'raw3',url_processed:'history'},
    {id:4,url:'raw4',url_processed:'unready'},
    {...ready,id:5,url:'raw5',url_processed:'deleted',deleted_at:new Date()},
  ];
  const statements=[];
  const client = {release(){},async query(sql){ statements.push(sql);
    if(sql.includes('FROM images')) return {rows:images};
    if(sql.includes('FROM image_source_history')) return {rows:[{source_url:'oldraw',image_snapshot:{url_processed:'history'}}]};
    return {rows:[]};
  }};
  const result = await auditImageStorage({pool:{connect:async()=>client},identity:{database:'fixture'},
    storage:{extractObjectName:x=>x,statFile:async()=>({size:100,etag:'abc'})}});
  assert.equal(result.candidateBytes,100);
  assert.equal(result.legacyReferenceCount,5);
  assert.equal(result.objects.length,4);
  assert.equal(result.objects.find(o=>o.objectName==='history').status,'preserve');
  assert.equal(result.objects.find(o=>o.objectName==='deleted').status,'preserve');
  assert.ok(statements.every(s=>!/INSERT|UPDATE|DELETE/.test(s)));
});
