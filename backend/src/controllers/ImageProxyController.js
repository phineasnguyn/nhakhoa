const { pipeline } = require('node:stream');

function createImageProxy(storage = require('../services/storage')) {
  return async (req, res) => {
    try {
      const objectName = req.params[0];
      const info = await storage.statFile(objectName);
      const etag = `"${info.etag}"`;
      res.set('ETag', etag);
      res.set('Cache-Control', 'private, max-age=3600');
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
      if ((req.headers['if-none-match'] || '').split(',').some(value => ['*', etag].includes(value.trim().replace(/^W\//, '')))) {
        return res.status(304).end();
      }
      const stream = await storage.openFileStream(objectName);
      res.set('Content-Type', info.metaData?.['content-type'] || (/\.png$/i.test(objectName) ? 'image/png' : 'image/jpeg'));
      res.set('Content-Length', String(info.size));
      pipeline(stream, res, error => {
        if (error && !res.destroyed) res.destroy(error);
      });
    } catch (error) {
      if (!res.headersSent) res.status(error.code === 'NoSuchKey' || error.code === 'NotFound' ? 404 : 502).json({ error: 'Image unavailable' });
      else res.destroy(error);
    }
  };
}
module.exports = { createImageProxy };
