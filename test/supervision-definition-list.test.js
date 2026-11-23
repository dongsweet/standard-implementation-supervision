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
