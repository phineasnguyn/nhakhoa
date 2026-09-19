const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const express = require('express');
const { createImageProxy } = require('./ImageProxyController');

test('proxy streams once and serves conditional 304 without opening the object', async () => {
  let opened = 0;
  const app = express();
  app.get('/proxy/*', createImageProxy({ statFile: async()=>({etag:'abc',size:4,metaData:{'content-type':'image/png'}}),
    openFileStream: async()=>{opened++; return Readable.from(Buffer.from('test'));} }));
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const url = `http://127.0.0.1:${server.address().port}/proxy/test.png`;
  try {
    const response = await fetch(url);
    assert.equal(await response.text(),'test');
    assert.equal(response.headers.get('etag'),'"abc"');
    assert.equal(response.headers.get('cache-control'),'private, max-age=3600');
    const cached = await fetch(url,{headers:{'if-none-match':'W/"abc"'}});
    assert.equal(cached.status,304);
    assert.equal(opened,1);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
