'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Repository = require('../app/repository/supervisionDefinition');

test('saves manual plan notes and appends a human-readable revision record', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: 0 };
      if (statement.startsWith('SELECT object_name, scope, recognized_object')) {
        return {
          rows: [ {
            object_name: '旧对象',
            scope: '',
            recognized_object: true,
            object_category: '管理制度',
            check_layer: '管理层面',
            check_method: '证据材料核查',
            description: '旧描述',
            steps: '旧步骤',
            frequency: '每年',
            access_mode: '现场',
            priority: '重点项',
            reference_result: null,
            reference_materials: null,
            notes: '旧人工备注',
            centers: [ '总部' ],
            standard_item_ids: [ '00000000-0000-0000-0000-000000000010' ],
          } ],
          rowCount: 1,
        };
      }
      if (statement.startsWith('SELECT id FROM standard_items')) {
        return { rows: [ { id: '00000000-0000-0000-0000-000000000011' } ], rowCount: 1 };
      }
      if (statement.startsWith('UPDATE supervision_definitions SET object_name')) {
        return { rows: [ { id: 'plan-1' } ], rowCount: 1 };
      }
      if (statement.startsWith('DELETE FROM supervision_definition_standard_items')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_definition_standard_items')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('DELETE FROM supervision_definition_centers')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_definition_centers')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_object_categories')) {
        return { rows: [ { id: 'category-1' } ], rowCount: 1 };
      }
      if (statement.startsWith('SELECT id, category_id FROM supervision_objects')) {
        return { rows: [ { id: 'object-1', category_id: 'category-1' } ], rowCount: 1 };
      }
      if (statement.startsWith('INSERT INTO supervision_object_aliases')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('UPDATE supervision_definitions SET canonical_object_id')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('UPDATE supervision_definitions SET change_history')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new Repository({ connect: async () => client });
  await repository.update('plan-1', {
    fields: {
      objectName: '新对象',
      scope: '',
      centers: [ '总部' ],
      recognizedObject: true,
      objectCategory: '管理制度',
      checkLayer: '技术层面',
      checkMethod: '上机查看',
      description: '新描述',
      steps: '旧步骤',
      frequency: '每年',
      accessMode: '现场',
      priority: '重点项',
      referenceResult: '',
      referenceMaterials: '',
      notes: '新的业务背景备注',
      normalizedHash: 'a'.repeat(64),
    },
    standardItemIds: [ '00000000-0000-0000-0000-000000000011' ],
  }, 'user-1');

  const update = calls.find(call => call.statement.startsWith('UPDATE supervision_definitions SET object_name'));
  assert.equal(update.values[15], '新的业务背景备注');
  const history = calls.find(call => call.statement.startsWith('UPDATE supervision_definitions SET change_history'));
  assert.ok(history);
  assert.match(history.values[1], /检查对象/);
  assert.match(history.values[1], /检查层面/);
  assert.match(history.values[1], /检查方法/);
  assert.match(history.values[1], /检查描述/);
  assert.match(history.values[1], /关联标准项/);
  assert.match(history.values[1], /方案备注/);
  assert.ok(calls.some(call => call.statement === 'COMMIT'));
});
