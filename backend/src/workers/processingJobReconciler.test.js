const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileProcessingJobs } = require('./processingJobReconciler');

test('reconcile re-enqueues missing creating jobs by the original id and preserves completed partial results', async()=>{
  const updates=[]; const added=[];
  const client = {release(){},async query(sql,params){
    if(sql.includes('SELECT *')) return {rows:[{id:7,visit_id:2,created_by:3},{id:8}]};
    if(sql.includes('UPDATE')) updates.push(params);
    return {rows:[]};
  }};
  const queue = {getJob:async id=>id==='8'?{getState:async()=>'completed',returnvalue:{status:'partial'}}:null,
    add:async(name,data,opts)=>{added.push({data,opts});return {getState:async()=>'waiting'};}};
  await reconcileProcessingJobs({pool:{connect:async()=>client},queue});
  assert.deepEqual(added,[{data:{visitId:2,userId:3},opts:{jobId:'7'}}]);
  assert.equal(updates[0][2],'queued'); assert.equal(updates[1][2],'partial');
});
