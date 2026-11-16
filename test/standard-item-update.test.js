'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const StandardCatalogRepository = require('../app/repository/standardCatalog');

function createRepository({ itemExists = true } = {}) {
  const calls = [];
  const client = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push(statement);
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rowCount: null, rows: [] };
      if (statement.startsWith('SELECT si.id, si.standard_version_id')) {
        return itemExists
          ? { rowCount: 1, rows: [ { id: 'item-1', standard_version_id: 'version-1', item_code: '12.1.1 c)', title: '一般要求', explanation: null, content: '旧内容', version: '2023', standard_code: '31168' } ] }
          : { rowCount: 0, rows: [] };
      }
      if (statement.startsWith('UPDATE standard_items')) return { rowCount: 1, rows: [ { id: 'item-1', item_code: '12.1.1 c)', content: '按照[赋值：云服务商定义的频率]审查事件处理计划。' } ] };
      if (statement.startsWith('INSERT INTO audit_logs')) return { rowCount: 1, rows: [] };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  return { repository: new StandardCatalogRepository({ connect: async () => client }), calls };
}

test('updates a standard item content and records an audit entry', async () => {
  const { repository, calls } = createRepository();
  const result = await repository.updateItem({
    itemId: 'item-1',
    itemCode: '12.1.1 c)',
    title: '一般要求',
    explanation: null,
    content: '按照[赋值：云服务商定义的频率]审查事件处理计划。',
    actorId: 'user-1',
  });

  assert.equal(result.id, 'item-1');
  assert.ok(calls.includes('COMMIT'));
  assert.ok(calls.some(statement => statement.startsWith('INSERT INTO audit_logs')));
  assert.ok(!calls.includes('ROLLBACK'));
});

test('returns null without updating when the standard item does not exist', async () => {
  const { repository, calls } = createRepository({ itemExists: false });
  const result = await repository.updateItem({
    itemId: 'missing', itemCode: '12.1.1 c)', title: null, explanation: null, content: '内容', actorId: 'user-1',
  });

  assert.equal(result, null);
  assert.ok(calls.includes('ROLLBACK'));
  assert.ok(!calls.includes('COMMIT'));
});
