const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorageDeletionService } = require('./storageDeletionService');

function createFixture(options = {}) {
  const deleteCalls = [];
  const queryLog = [];
  const deleteResults = [...(options.deleteResults || [])];
  const state = {
    id: 51,
    patient_id: 7,
    immediate_object_names: [...(options.immediateObjectNames || [])],
    shared_object_names: [...(options.sharedObjectNames || [])],
    status: 'pending',
    attempts: 0,
    deleted_count: 0,
    preserved_count: 0,
    last_error: null,
  };

  const pool = {
    async query(sql, params = []) {
      const compactSql = sql.replace(/\s+/g, ' ').trim();
      queryLog.push({ sql: compactSql, params });

      if (compactSql.startsWith('UPDATE storage_deletion_jobs AS job')) {
        if (!['pending', 'failed', 'processing'].includes(state.status)) return { rows: [] };
        state.status = 'processing';
        state.attempts += 1;
        return { rows: [{ ...state }] };
      }

      if (compactSql === 'SELECT * FROM storage_deletion_jobs WHERE id = $1') {
        return { rows: [{ ...state }] };
      }

      if (compactSql.includes("SET immediate_object_names = '[]'::jsonb")) {
        state.immediate_object_names = [];
        state.deleted_count += Number(params[0]);
        return { rows: [{ ...state }] };
      }

      if (compactSql.includes('SET shared_object_names = $1::jsonb')) {
        state.shared_object_names = JSON.parse(params[0]);
        state.deleted_count += Number(params[1]);
        state.preserved_count += Number(params[2]);
        state.status = params[3];
        state.last_error = params[4];
        return { rows: [{ ...state }] };
      }

      if (compactSql.includes('SET status = $1, last_error = $2')) {
        state.status = params[0];
        state.last_error = params[1];
        return { rows: [{ ...state }] };
      }

      throw new Error(`Unexpected pool query: ${compactSql}`);
    },
    async connect() {
      return {
        async query(sql) {
          const compactSql = sql.replace(/\s+/g, ' ').trim();
          queryLog.push({ sql: compactSql, params: [] });
          if (compactSql.startsWith('WITH object_references')) {
            return { rows: [{ referenced: Boolean(options.referenced) }] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };

  const storage = {
    async deleteFiles(objectNames) {
      deleteCalls.push([...objectNames]);
      return deleteResults.shift() || { success: true, deletedCount: objectNames.length };
    },
  };

  return {
    state,
    deleteCalls,
    queryLog,
    service: createStorageDeletionService({ pool, storage, retryDelayMs: 0 }),
  };
}

test('retries every immediate object after a partial MinIO failure and completes idempotently', async () => {
  const fixture = createFixture({
    immediateObjectNames: ['visits/10/raw.jpg', 'visits/10/annotations.json'],
    deleteResults: [
      { success: false, error: 'second object failed after the first was deleted' },
      { success: true, deletedCount: 2 },
    ],
  });

  const firstAttempt = await fixture.service.processDeletionJob(51);
  assert.equal(firstAttempt.status, 'pending');
  assert.deepEqual(fixture.state.immediate_object_names, [
    'visits/10/raw.jpg',
    'visits/10/annotations.json',
  ]);

  const secondAttempt = await fixture.service.processDeletionJob(51);
  assert.equal(secondAttempt.status, 'completed');
  assert.equal(secondAttempt.deletedCount, 2);
  assert.deepEqual(fixture.deleteCalls, [
    ['visits/10/raw.jpg', 'visits/10/annotations.json'],
    ['visits/10/raw.jpg', 'visits/10/annotations.json'],
  ]);
});

test('preserves a shared object after taking the advisory lock and finding a fresh reference', async () => {
  const fixture = createFixture({
    sharedObjectNames: ['processed_by_hash/shared.jpg'],
    referenced: true,
  });

  const result = await fixture.service.processDeletionJob(51);
  assert.equal(result.status, 'completed');
  assert.equal(result.preservedCount, 1);
  assert.equal(fixture.deleteCalls.length, 0);
  assert.ok(
    fixture.queryLog.some(({ sql }) => sql.includes('pg_advisory_xact_lock(hashtextextended($1, 0))'))
  );
  assert.ok(fixture.queryLog.some(({ sql }) => sql.startsWith('WITH object_references')));
});

test('deletes an unreferenced shared object while holding the advisory lock', async () => {
  const fixture = createFixture({
    sharedObjectNames: ['processed_by_hash/orphan.jpg'],
    referenced: false,
  });

  const result = await fixture.service.processDeletionJob(51);
  assert.equal(result.status, 'completed');
  assert.equal(result.deletedCount, 1);
  assert.deepEqual(fixture.deleteCalls, [['processed_by_hash/orphan.jpg']]);
});
