const test = require('node:test');
const assert = require('node:assert/strict');
const { ImageProcessingController } = require('./ImageProcessingController');

test('persists a creating job before enqueueing BullMQ and uses the database id as jobId', async () => {
  const events = [];
  let released = false;

  const client = {
    async query(sql) {
      const compactSql = sql.replace(/\s+/g, ' ').trim();
      events.push(compactSql);
      if (compactSql.startsWith('SELECT id FROM visits')) return { rows: [{ id: 10 }] };
      if (compactSql.startsWith('SELECT COUNT(*)::int AS total')) return { rows: [{ total: 2 }] };
      if (compactSql.startsWith('SELECT id, status, progress FROM processing_jobs')) return { rows: [] };
      if (compactSql.startsWith('INSERT INTO processing_jobs')) {
        return {
          rows: [{ id: 77, visit_id: 10, status: 'creating', total_images: 2 }],
        };
      }
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };

  const database = {
    pool: {
      async connect() {
        return client;
      },
    },
    async query(sql, params) {
      const compactSql = sql.replace(/\s+/g, ' ').trim();
      events.push(compactSql);
      assert.equal(params[0], '77');
      assert.equal(params[1], 77);
      return {
        rows: [{ id: 77, visit_id: 10, bullmq_job_id: '77', status: 'queued', total_images: 2 }],
      };
    },
  };

  const queue = {
    async add(name, data, options) {
      events.push('QUEUE_ADD');
      assert.equal(name, 'process-images');
      assert.deepEqual(data, { visitId: 10, userId: 5 });
      assert.equal(options.jobId, '77');
      return { id: '77' };
    },
  };

  const response = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  const controller = new ImageProcessingController({ queue, database });
  await controller.processRawImages(
    { params: { visitId: '10' }, user: { id: 5 } },
    response
  );

  const insertIndex = events.findIndex((event) => event.startsWith('INSERT INTO processing_jobs'));
  const commitIndex = events.indexOf('COMMIT');
  const enqueueIndex = events.indexOf('QUEUE_ADD');
  assert.ok(insertIndex >= 0 && insertIndex < commitIndex && commitIndex < enqueueIndex);
  assert.equal(response.statusCode, 202);
  assert.equal(response.payload.data.jobId, 77);
  assert.equal(response.payload.data.bullmqJobId, '77');
  assert.equal(released, true);
});
