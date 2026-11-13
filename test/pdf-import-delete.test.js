'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const StandardImportJobRepository = require('../app/repository/standardImportJob');
const { LocalStorageProvider } = require('../app/lib/storage');

function makeClient(row) {
  const queries = [];
  return {
    queries,
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      queries.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: null };
      if (statement.startsWith('SELECT id, status, storage_key')) return { rows: row ? [ row ] : [], rowCount: row ? 1 : 0 };
      if (statement.startsWith('DELETE FROM standard_import_jobs')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
}

test('cleans a completed PDF import job and keeps catalog data', async () => {
  const client = makeClient({
    id: 'job-1',
    status: 'completed',
    storage_key: 'standard-imports/version-1/job.pdf',
    comparison_storage_key: 'standard-imports/version-1/job-comparison.xlsx',
  });
  const repository = new StandardImportJobRepository({ connect: async () => client });
  const result = await repository.remove('job-1', 'version-1', 'user-1');

  assert.deepEqual(result, {
    status: 'completed',
    storageKey: 'standard-imports/version-1/job.pdf',
    comparisonStorageKey: 'standard-imports/version-1/job-comparison.xlsx',
  });
  assert.ok(client.queries.some(query => query.statement.startsWith('DELETE FROM standard_import_jobs')));
  assert.ok(client.queries.some(query => query.statement.startsWith('INSERT INTO audit_logs')));
  assert.ok(client.queries.some(query => query.statement === 'COMMIT'));
  assert.equal(client.queries.some(query => query.statement.startsWith('DELETE FROM standard_items')), false);
});

test('rejects cleanup while a PDF import job is running', async () => {
  const client = makeClient({
    id: 'job-2',
    status: 'processing',
    storage_key: 'standard-imports/version-1/job.pdf',
    comparison_storage_key: null,
  });
  const repository = new StandardImportJobRepository({ connect: async () => client });

  await assert.rejects(
    repository.remove('job-2', 'version-1', 'user-1'),
    error => error && error.code === 'IMPORT_JOB_BUSY'
  );
  assert.equal(client.queries.some(query => query.statement.startsWith('DELETE FROM standard_import_jobs')), false);
  assert.ok(client.queries.some(query => query.statement === 'ROLLBACK'));
});

test('returns not found when the job does not belong to the version', async () => {
  const client = makeClient(null);
  const repository = new StandardImportJobRepository({ connect: async () => client });

  await assert.rejects(
    repository.remove('job-3', 'version-1', 'user-1'),
    error => error && error.code === 'IMPORT_JOB_NOT_FOUND'
  );
  assert.ok(client.queries.some(query => query.statement === 'ROLLBACK'));
});

test('storage cleanup is idempotent for existing and missing temporary files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'standard-import-storage-'));
  try {
    const storage = new LocalStorageProvider(root);
    await storage.put('standard-imports/job.pdf', Buffer.from('pdf'));
    await storage.remove('standard-imports/job.pdf');
    await storage.remove('standard-imports/job.pdf');
    await assert.rejects(fs.readFile(path.join(root, 'standard-imports/job.pdf')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
