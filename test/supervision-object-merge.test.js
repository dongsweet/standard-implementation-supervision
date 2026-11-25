'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Repository = require('../app/repository/supervisionDefinition');

test('merges a source object into a canonical object and migrates plans and aliases', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT' ].includes(statement)) return { rows: [], rowCount: 0 };
      if (statement.startsWith('SELECT id, canonical_name, category_id, status')) {
        return {
          rows: [
            { id: 'source-object', canonical_name: '《曙光云软件安全管理规范》', category_id: 'category-source', status: 'active' },
            { id: 'target-object', canonical_name: '云平台软件开发安全管理规范', category_id: 'category-target', status: 'active' },
          ],
          rowCount: 2,
        };
      }
      if (statement.startsWith('SELECT d.id, d.object_name, d.object_category')) {
        return {
          rows: [
            {
              id: 'plan-172', object_name: '《曙光云软件安全管理规范》', object_category: '内部供应材料',
              check_layer: '管理层面', check_method: '证据材料核查', description: '方案一',
              steps: '步骤一', frequency: '每年', plan_number: 172,
            },
            {
              id: 'plan-933', object_name: '《曙光云软件安全管理规范》', object_category: '内部供应材料',
              check_layer: '管理层面', check_method: '证据材料核查', description: '方案二',
              steps: '步骤二', frequency: '每年', plan_number: 933,
            },
          ],
          rowCount: 2,
        };
      }
      if (statement.startsWith('SELECT alias_name, normalized_name, center_name')) {
        return { rows: [ { alias_name: '《曙光云软件安全管理规范》', normalized_name: '曙光云软件安全管理规范', center_name: '总部' } ], rowCount: 1 };
      }
      if (statement.startsWith('INSERT INTO supervision_object_aliases')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('DELETE FROM supervision_object_aliases')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('UPDATE supervision_definitions')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('UPDATE supervision_objects')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new Repository({ connect: async () => client });
  const result = await repository.mergeObject('source-object', 'target-object', 'user-1');
  assert.equal(result.targetId, 'target-object');
  assert.equal(result.affectedPlanCount, 2);
  assert.deepEqual(result.affectedPlanNumbers, [ 172, 933 ]);
  const planUpdates = calls.filter(call => call.statement.startsWith('UPDATE supervision_definitions'));
  assert.equal(planUpdates.length, 2);
  assert.equal(planUpdates[0].values[1], '云平台软件开发安全管理规范');
  assert.equal(planUpdates[0].values[2], 'target-object');
  assert.ok(calls.some(call => call.statement.startsWith('UPDATE supervision_objects')
    && call.statement.includes("status = 'merged'")
    && call.values[0] === 'source-object'
    && call.values[1] === 'target-object'));
  const audit = calls.find(call => call.statement.startsWith('INSERT INTO audit_logs'));
  assert.ok(audit);
  assert.equal(audit.statement.includes('merge_supervision_object'), true);
  assert.ok(calls.some(call => call.statement === 'COMMIT'));
});

test('rejects merging an object into itself and rolls back', async () => {
  let rolledBack = false;
  const client = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (statement === 'BEGIN') return { rows: [] };
      if (statement === 'ROLLBACK') {
        rolledBack = true;
        return { rows: [] };
      }
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new Repository({ connect: async () => client });
  await assert.rejects(repository.mergeObject('same-object', 'same-object', 'user-1'), /来源对象和保留对象不能相同/);
  assert.equal(rolledBack, false);
});
