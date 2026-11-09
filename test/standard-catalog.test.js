'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const StandardCatalogRepository = require('../app/repository/standardCatalog');

function createRepository({ versionRow = { id: 'version-1', standard_id: 'standard-1', version: '2026' }, failVersionUpdate = false } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push(statement);
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rowCount: null, rows: [] };
      if (statement.startsWith('UPDATE standards')) {
        return {
          rowCount: 1,
          rows: [ { id: 'standard-1', code: 'GB/T 31168', name: '云计算服务安全能力要求' } ],
        };
      }
      if (statement.startsWith('UPDATE standard_versions')) {
        if (failVersionUpdate) {
          const error = new Error('duplicate version');
          error.code = '23505';
          throw error;
        }
        return { rowCount: versionRow ? 1 : 0, rows: versionRow ? [ versionRow ] : [] };
      }
      throw new Error('Unexpected query: ' + statement);
    },
    release() {
      released = true;
    },
  };
  return {
    repository: new StandardCatalogRepository({ connect: async () => client }),
    calls,
    isReleased: () => released,
  };
}

const edit = {
  standardId: 'standard-1',
  versionId: 'version-1',
  code: 'GB/T 31168',
  name: '云计算服务安全能力要求',
  description: null,
  standardType: 'national',
  issuingOrganization: null,
  version: '2026',
};

test('updates standard metadata and its selected version atomically', async () => {
  const { repository, calls, isReleased } = createRepository();
  const result = await repository.updateStandard(edit);

  assert.equal(result.id, 'standard-1');
  assert.equal(result.version.version, '2026');
  assert.ok(calls.includes('COMMIT'));
  assert.ok(!calls.includes('ROLLBACK'));
  assert.equal(isReleased(), true);
});

test('rolls back when the selected version does not belong to the standard', async () => {
  const { repository, calls, isReleased } = createRepository({ versionRow: null });
  const result = await repository.updateStandard(edit);

  assert.equal(result, null);
  assert.ok(calls.includes('ROLLBACK'));
  assert.ok(!calls.includes('COMMIT'));
  assert.equal(isReleased(), true);
});

test('rolls back and propagates duplicate-key errors', async () => {
  const { repository, calls, isReleased } = createRepository({ failVersionUpdate: true });

  await assert.rejects(repository.updateStandard(edit), error => error.code === '23505');
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(isReleased(), true);
});
