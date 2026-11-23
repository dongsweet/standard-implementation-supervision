'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Repository = require('../app/repository/supervisionDefinition');

test('filters and paginates supervision definitions with stable readable-number ordering', async () => {
  const calls = [];
  const pool = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if (statement.startsWith('SELECT count(*)')) return { rows: [ { total: 45 } ], rowCount: 1 };
      if (statement.startsWith('SELECT d.id')) {
        return { rows: [ { id: 'definition-21', plan_number: 21, standard_items: [] } ], rowCount: 1 };
      }
      throw new Error('Unexpected query: ' + statement);
    },
  };
  const repository = new Repository(pool);
  const result = await repository.listDefinitions({
    search: '021',
    status: 'active',
    priority: '重点项',
    checkMethod: '访谈',
    center: '云中心',
    page: 2,
    pageSize: 20,
  });

  assert.equal(result.total, 45);
  assert.equal(result.page, 2);
  assert.equal(result.pageCount, 3);
  assert.equal(result.rows[0].plan_number, 21);
  assert.deepEqual(calls[0].values, [ '%021%', 'active', '重点项', '%访谈%', '云中心' ]);
  assert.deepEqual(calls[1].values, [ '%021%', 'active', '重点项', '%访谈%', '云中心', 20, 20 ]);
  assert.match(calls[0].statement, /CASE WHEN d\.plan_number < 1000 THEN lpad\(d\.plan_number::text, 3, '0'\) ELSE d\.plan_number::text END/);
  assert.match(calls[0].statement, /d\.status = \$2/);
  assert.match(calls[0].statement, /d\.priority = \$3/);
  assert.match(calls[0].statement, /d\.check_method ILIKE \$4/);
  assert.match(calls[0].statement, /filter_si\.standard_number ILIKE \$1/);
  assert.match(calls[1].statement, /ORDER BY d\.status, d\.plan_number/);
  assert.match(calls[0].statement, /dc\.center_name = \$5/);
  assert.match(calls[1].statement, /LIMIT \$6 OFFSET \$7/);
});

test('clamps out-of-range supervision pages before querying rows', async () => {
  const calls = [];
  const pool = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if (statement.startsWith('SELECT count(*)')) return { rows: [ { total: 45 } ], rowCount: 1 };
      if (statement.startsWith('SELECT d.id')) return { rows: [], rowCount: 0 };
      throw new Error('Unexpected query: ' + statement);
    },
  };
  const result = await new Repository(pool).listDefinitions({ page: 999, pageSize: 20 });

  assert.equal(result.page, 3);
  assert.equal(result.pageCount, 3);
  assert.deepEqual(calls[1].values, [ 20, 40 ]);
});

test('merges center object names and updates plans only within the selected center', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT' ].includes(statement)) return { rows: [], rowCount: 0 };
      if (statement.startsWith('SELECT d.id, d.object_name')) return {
        rows: [
          {
            id: 'plan-1', object_name: '《采购合同或协议》', object_category: '管理',
            check_layer: '管理层面', check_method: '证据材料核查', description: '检查合同A',
            steps: null, frequency: null, access_mode: null, priority: null,
            reference_result: null, reference_materials: null, centers: [ '总部' ],
          },
          {
            id: 'plan-2', object_name: '采购合同或协议', object_category: '管理',
            check_layer: '管理层面', check_method: '证据材料核查', description: '检查合同B',
            steps: null, frequency: null, access_mode: null, priority: null,
            reference_result: null, reference_materials: null, centers: [ '总部' ],
          },
        ],
        rowCount: 2,
      };
      if (statement.startsWith('UPDATE supervision_definitions')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_object_dedupe_reviews')) return {
        rows: [ { id: 'review-1', decision: 'merged' } ],
        rowCount: 1,
      };
      if (statement.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new Repository({ connect: async () => client });
  const result = await repository.reviewCenterObject({
    centerName: '总部', leftObjectName: '《采购合同或协议》', rightObjectName: '采购合同或协议',
    decision: 'merged', canonicalObjectName: '采购合同或协议', reviewerId: 'user-1',
  });
  assert.equal(result.id, 'review-1');
  const update = calls.find(call => call.statement.startsWith('UPDATE supervision_definitions'));
  assert.equal(update.values[0], 'plan-1');
  assert.equal(update.values[1], '采购合同或协议');
  const reviewInsert = calls.find(call => call.statement.startsWith('INSERT INTO supervision_object_dedupe_reviews'));
  assert.deepEqual(JSON.parse(reviewInsert.values[7]), [ 'plan-1' ]);
  assert.ok(calls.some(call => call.statement === 'COMMIT'));
});

test('lists center and object combinations with independent filters and pagination', async () => {
  const calls = [];
  const pool = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if (statement.startsWith('SELECT count(*)')) return { rows: [ { total: 25 } ], rowCount: 1 };
      if (statement.startsWith('SELECT dc.center_name')) {
        return { rows: [ { center_name: '云中心', object_name: '云平台', plan_count: 2 } ], rowCount: 1 };
      }
      throw new Error('Unexpected query: ' + statement);
    },
  };
  const result = await new Repository(pool).listCenterObjects({ center: '云中心', search: '云平台', page: 2, pageSize: 20 });

  assert.equal(result.total, 25);
  assert.equal(result.page, 2);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.rows[0], { center_name: '云中心', object_name: '云平台', plan_count: 2 });
  assert.deepEqual(calls[0].values, [ '云中心', '%云平台%' ]);
  assert.deepEqual(calls[1].values, [ '云中心', '%云平台%', 20, 20 ]);
  assert.match(calls[0].statement, /GROUP BY dc\.center_name, d\.object_name/);
  assert.match(calls[1].statement, /ORDER BY dc\.center_name, d\.object_name LIMIT \$3 OFFSET \$4/);
});
