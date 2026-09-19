const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcessedImageReferenceService } = require('./processedImageReferenceService');

test('locks the hash before uploading and committing a processed image reference', async () => {
  const events = [];
  let released = false;

  const client = {
    async query(sql, params = []) {
      const compactSql = sql.replace(/\s+/g, ' ').trim();
      events.push({ event: compactSql, params });
      if (compactSql.startsWith('SELECT id FROM images')) return { rows: [{ id: 20 }] };
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };

  const storage = {
    computeHash() {
      return 'abc123';
    },
    async ensureUploadByHash(_buffer, prefix, ext, contentType) {
      events.push({ event: 'UPLOAD' });
      assert.equal(prefix, 'processed_by_hash');
      assert.equal(ext, 'jpg');
      assert.equal(contentType, 'image/jpeg');
      return {
        success: true,
        objectName: 'processed_by_hash/abc123.jpg',
        hash: 'abc123',
      };
    },
  };

  const service = createProcessedImageReferenceService({
    pool: { connect: async () => client },
    storage,
  });

  const result = await service.storeProcessedImageReference(20, Buffer.from('image'), 'jpg');
  assert.equal(result.success, true);
  assert.equal(result.urlProcessed, '/nhakhoa/processed_by_hash/abc123.jpg');

  const imageLockIndex = events.findIndex(({ event }) => event.startsWith('SELECT id FROM images'));
  const advisoryLockIndex = events.findIndex(({ event }) => event.includes('pg_advisory_xact_lock'));
  const uploadIndex = events.findIndex(({ event }) => event === 'UPLOAD');
  const updateIndex = events.findIndex(({ event }) => event.startsWith('UPDATE images'));
  const commitIndex = events.findIndex(({ event }) => event === 'COMMIT');

  assert.ok(
    imageLockIndex < advisoryLockIndex
      && advisoryLockIndex < uploadIndex
      && uploadIndex < updateIndex
      && updateIndex < commitIndex
  );
  assert.equal(
    events[advisoryLockIndex].params[0],
    'processed_by_hash/abc123.jpg'
  );
  assert.equal(released, true);
});

test('does not upload when the image was deleted before the worker acquired its lock', async () => {
  let uploaded = false;
  let released = false;
  const client = {
    async query(sql) {
      const compactSql = sql.replace(/\s+/g, ' ').trim();
      if (compactSql.startsWith('SELECT id FROM images')) return { rows: [] };
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  const service = createProcessedImageReferenceService({
    pool: { connect: async () => client },
    storage: {
      computeHash: () => 'abc123',
      ensureUploadByHash: async () => {
        uploaded = true;
        return { success: true };
      },
    },
  });

  const result = await service.storeProcessedImageReference(20, Buffer.from('image'), 'jpg');
  assert.equal(result.skipped, true);
  assert.equal(uploaded, false);
  assert.equal(released, true);
});
