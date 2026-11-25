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
  assert.match(calls[1].statement, /d\.canonical_object_id/);
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

test('searches standard items by number, title, and content in one query', async () => {
  let captured;
  const repository = new Repository({
    async query(sql, values = []) {
      captured = { statement: sql.replace(/\s+/g, ' ').trim(), values };
      return {
        rows: [ {
          id: 'item-1',
          code: '6.1.1',
          standardNumber: 'GB/T 31168 / 2023 · 10.1.2',
          title: '增强要求',
          standardCode: 'GB/T 31168',
          version: '2023',
          preview: '正文内容',
        } ],
        rowCount: 1,
      };
    },
  });
  const result = await repository.searchStandardItems('访问控制', 30);
  assert.equal(result.length, 1);
  assert.deepEqual(captured.values, [ '%访问控制%', '访问控制%', 30 ]);
  assert.match(captured.statement, /si\.item_code ILIKE \$1/);
  assert.match(captured.statement, /si\.standard_number ILIKE \$1/);
  assert.match(captured.statement, /si\.title, ''\) ILIKE \$1/);
  assert.match(captured.statement, /si\.content ILIKE \$1/);
  assert.match(captured.statement, /LIMIT \$3/);
});

test('loads compact object choices and editable layer and frequency options', async () => {
  const calls = [];
  const repository = new Repository({
    async query(sql) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push(statement);
      if (statement.startsWith('SELECT DISTINCT btrim(check_layer)')) {
        return { rows: [ { value: '管理层面' }, { value: '技术层面' } ] };
      }
      if (statement.startsWith('SELECT DISTINCT btrim(frequency)')) {
        return { rows: [ { value: '每年' }, { value: '每季度' } ] };
      }
      throw new Error('Unexpected query: ' + statement);
    },
  });
  const options = await repository.listDefinitionFieldOptions();
  assert.deepEqual(options.checkLayerOptions, [ '管理层面', '技术层面' ]);
  assert.deepEqual(options.frequencyOptions, [ '每年', '每季度' ]);
  assert.equal(calls.length, 2);
});

test('lists canonical supervision objects with category and center filters', async () => {
  const calls = [];
  const pool = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if (statement.startsWith('SELECT count(*)')) return { rows: [ { total: 21 } ], rowCount: 1 };
      if (statement.startsWith('SELECT o.id')) return {
        rows: [ { id: 'object-1', canonical_name: '云平台', object_category: '技术', centers: [ '云中心' ], aliases: [ '云平台' ], plan_count: 2, standard_item_count: 3, plan_numbers: [ 1, 2 ] } ],
        rowCount: 1,
      };
      throw new Error('Unexpected query: ' + statement);
    },
  };
  const result = await new Repository(pool).listObjectWorkbench({ center: '云中心', search: '云平台', category: '技术', page: 2, pageSize: 20 });
  assert.equal(result.total, 21);
  assert.equal(result.page, 2);
  assert.equal(result.pageCount, 2);
  assert.equal(result.rows[0].canonical_name, '云平台');
  assert.deepEqual(calls[0].values, [ '云中心', '%云平台%', '技术' ]);
  assert.deepEqual(calls[1].values, [ '云中心', '%云平台%', '技术', 20, 20 ]);
  assert.match(calls[0].statement, /COALESCE\(c\.name, ''\) ILIKE \$2/);
  assert.match(calls[1].statement, /GROUP BY o\.id, c\.name/);
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
      if (statement.startsWith('INSERT INTO supervision_object_aliases')) return { rows: [], rowCount: 1 };
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

test('deletes an unused object category and records the action', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (statement.startsWith('SELECT id, name FROM supervision_object_categories')) return { rows: [ { id: 'category-1', name: '业务平台' } ], rowCount: 1 };
      if (statement.startsWith('SELECT count(*)::integer AS object_count')) return { rows: [ { object_count: 0 } ], rowCount: 1 };
      if (statement.startsWith('DELETE FROM supervision_object_categories')) return { rows: [ { id: 'category-1', name: '业务平台' } ], rowCount: 1 };
      if (statement.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const result = await new Repository({ connect: async () => client }).deleteObjectCategory('category-1', 'user-1');
  assert.equal(result.name, '业务平台');
  assert.ok(calls.some(call => call.statement === 'COMMIT'));
  assert.ok(calls.some(call => call.statement.startsWith('INSERT INTO audit_logs')));
});

test('refuses to delete an object category that is still assigned', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push(statement);
      if (statement === 'BEGIN' || statement === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (statement.startsWith('SELECT id, name FROM supervision_object_categories')) return { rows: [ { id: 'category-1', name: '业务平台' } ], rowCount: 1 };
      if (statement.startsWith('SELECT count(*)::integer AS object_count')) return { rows: [ { object_count: 2 } ], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new Repository({ connect: async () => client });
  await assert.rejects(repository.deleteObjectCategory('category-1', 'user-1'), error => error.code === 'CATEGORY_IN_USE');
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(calls.some(statement => statement.startsWith('DELETE FROM supervision_object_categories')), false);
});
