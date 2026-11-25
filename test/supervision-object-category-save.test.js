'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Repository = require('../app/repository/supervisionDefinition');

test('adopts an unregistered historical category atomically when sorting an object', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT' ].includes(statement)) return { rows: [], rowCount: 0 };
      if (statement.startsWith('SELECT id, name FROM supervision_object_categories')) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.startsWith('INSERT INTO supervision_object_categories')) {
        return { rows: [ { id: 'category-created', name: '内部供应材料' } ], rowCount: 1 };
      }
      if (statement.startsWith('SELECT id FROM supervision_objects')) return { rows: [], rowCount: 0 };
      if (statement.startsWith('SELECT d.id, d.object_name')) {
        return {
          rows: [ {
            id: 'plan-1',
            object_name: '《外部供应商清单》',
            check_layer: '管理层面',
            check_method: '证据材料核查',
            description: '检查供应商清单',
            steps: '核对供应商',
            frequency: '每年',
            centers: [ '总部' ],
          } ],
          rowCount: 1,
        };
      }
      if (statement.startsWith('INSERT INTO supervision_object_aliases')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('UPDATE supervision_definitions')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('UPDATE supervision_objects')) {
        return { rows: [ { id: 'object-1', category_id: 'category-created' } ], rowCount: 1 };
      }
      if (statement.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new Repository({ connect: async () => client });
  const result = await repository.updateObject('object-1', {
    canonicalName: '《外部供应商清单》',
    categoryId: null,
    categoryName: '内部供应材料',
    notes: '采用历史分类',
  }, 'user-1');
  assert.equal(result.category_id, 'category-created');
  const createCategory = calls.find(call => call.statement.startsWith('INSERT INTO supervision_object_categories'));
  assert.ok(createCategory);
  assert.deepEqual(createCategory.values, [ '内部供应材料' ]);
  const updatePlan = calls.find(call => call.statement.startsWith('UPDATE supervision_definitions'));
  assert.equal(updatePlan.values[1], '《外部供应商清单》');
  assert.equal(updatePlan.values[2], '内部供应材料');
  assert.ok(calls.some(call => call.statement === 'COMMIT'));
});
