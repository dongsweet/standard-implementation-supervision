'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Repository = require('../app/repository/supervisionDefinition');

test('moves all category objects and their active plans into the retained category', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT' ].includes(statement)) return { rows: [], rowCount: 0 };
      if (statement.startsWith('SELECT id, name, status FROM supervision_object_categories')) {
        return {
          rows: [
            { id: 'category-source', name: '内部统计', status: 'active' },
            { id: 'category-target', name: '业务平台', status: 'active' },
          ],
          rowCount: 2,
        };
      }
      if (statement.startsWith('SELECT id, canonical_name FROM supervision_objects')) {
        return {
          rows: [
            { id: 'object-1', canonical_name: '对象一' },
            { id: 'object-2', canonical_name: '对象二' },
          ],
          rowCount: 2,
        };
      }
      if (statement.startsWith('SELECT d.id, d.canonical_object_id')) {
        return {
          rows: [
            {
              id: 'plan-1', canonical_object_id: 'object-1', object_name: '对象一',
              check_layer: '管理层面', check_method: '证据材料核查', description: '方案一',
              steps: '步骤', frequency: '每年',
            },
            {
              id: 'plan-2', canonical_object_id: 'object-2', object_name: '对象二',
              check_layer: '技术层面', check_method: '上机查看', description: '方案二',
              steps: '步骤', frequency: '每季度',
            },
          ],
          rowCount: 2,
        };
      }
      if (statement.startsWith('UPDATE supervision_definitions')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('UPDATE supervision_objects')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('DELETE FROM supervision_object_categories')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new Repository({ connect: async () => client });
  const result = await repository.mergeObjectCategory('category-source', 'category-target', 'user-1');
  assert.equal(result.sourceName, '内部统计');
  assert.equal(result.targetName, '业务平台');
  assert.equal(result.movedObjectCount, 2);
  assert.equal(result.updatedPlanCount, 2);
  const planUpdates = calls.filter(call => call.statement.startsWith('UPDATE supervision_definitions'));
  assert.equal(planUpdates.length, 2);
  assert.equal(planUpdates[0].values[1], '业务平台');
  assert.match(planUpdates[0].values[2], /^[a-f0-9]{64}$/);
  assert.ok(calls.some(call => call.statement.startsWith('UPDATE supervision_objects')
    && call.values[1] === 'category-target'));
  assert.ok(calls.some(call => call.statement.startsWith('DELETE FROM supervision_object_categories')
    && call.values[0] === 'category-source'));
  assert.ok(calls.some(call => call.statement === 'COMMIT'));
});

test('rejects merging a category into itself', async () => {
  const repository = new Repository({
    connect: async () => { throw new Error('database should not be accessed'); },
  });
  await assert.rejects(
    repository.mergeObjectCategory('same-category', 'same-category', 'user-1'),
    /来源分类和目标分类不能相同/
  );
});
