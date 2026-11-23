'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Repository = require('../app/repository/supervisionExecution');

test('limits supervision options and execution results to the project standard snapshot', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if (statement === 'BEGIN' || statement === 'ROLLBACK') return { rows: [], rowCount: null };
      if (statement.startsWith('SELECT si.id')) return { rows: [ { id: 'item-in-project' } ], rowCount: 1 };
      if (statement.startsWith('SELECT center_name FROM supervision_definition_centers')) return { rows: [], rowCount: 0 };
      if (statement.startsWith('SELECT 1 FROM project_cloud_centers')) return { rows: [], rowCount: 0 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const pool = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if (statement.startsWith('SELECT d.id')) return { rows: [ { id: 'definition-1', standard_items: [ { id: 'item-in-project' } ] } ], rowCount: 1 };
      if (statement.startsWith('SELECT cc.id')) return { rows: [], rowCount: 0 };
      throw new Error('Unexpected query: ' + statement);
    },
    async connect() { return client; },
  };
  const repository = new Repository(pool);
  const options = await repository.listOptions('project-1');
  assert.equal(options.definitions.length, 1);
  const definitionsQuery = calls.find(call => call.statement.startsWith('SELECT d.id'));
  assert.deepEqual(definitionsQuery.values, [ 'project-1' ]);
  assert.match(definitionsQuery.statement, /JOIN project_standard_items psi/);
  assert.match(definitionsQuery.statement, /HAVING count\(psi\.standard_item_id\) > 0/);
  assert.match(definitionsQuery.statement, /EXISTS \(SELECT 1 FROM supervision_definition_centers/);

  await assert.rejects(repository.create({
    projectId: 'project-1',
    definitionId: 'definition-1',
    checkedAt: '2026-11-20T10:00:00.000Z',
    checkedBy: 'user-1',
    overallResult: '',
    notes: '',
    itemResults: new Map([ [ 'item-outside-project', { result: 'satisfied' } ] ]),
  }), error => error.code === 'INVALID_ITEM_RESULTS');
  const definitionQuery = calls.find(call => call.statement.startsWith('SELECT si.id'));
  assert.deepEqual(definitionQuery.values, [ 'definition-1', 'project-1' ]);
  assert.match(definitionQuery.statement, /JOIN project_standard_items psi/);
  assert.ok(calls.some(call => call.statement === 'ROLLBACK'));
  assert.equal(calls.some(call => call.statement.startsWith('INSERT INTO supervision_executions')), false);
});

test('writes execution results and an audit entry atomically', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: null };
      if (statement.startsWith('SELECT si.id')) return { rows: [ { id: 'item-1' } ], rowCount: 1 };
      if (statement.startsWith('SELECT center_name FROM supervision_definition_centers')) return { rows: [], rowCount: 0 };
      if (statement.startsWith('INSERT INTO supervision_executions')) return { rows: [ { id: 'execution-1' } ], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_item_results')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new Repository({ connect: async () => client });
  const execution = await repository.create({
    projectId: 'project-1',
    definitionId: 'definition-1',
    cloudCenterId: null,
    checkedAt: '2026-11-20T10:00:00.000Z',
    checkedBy: 'user-1',
    overallResult: 'satisfied',
    notes: '已完成检查',
    itemResults: new Map([ [ 'item-1', { result: 'satisfied', description: '', problemDescription: '' } ] ]),
  });
  assert.equal(execution.id, 'execution-1');
  assert.ok(calls.findIndex(call => call.statement.startsWith('INSERT INTO audit_logs')) > calls.findIndex(call => call.statement.startsWith('INSERT INTO supervision_item_results')));
  assert.equal(calls.at(-1).statement, 'COMMIT');
  const audit = calls.find(call => call.statement.startsWith('INSERT INTO audit_logs'));
  assert.equal(audit.values[0], 'user-1');
  assert.equal(audit.values[1], 'execution-1');
  assert.deepEqual(JSON.parse(audit.values[2]), {
    projectId: 'project-1', definitionId: 'definition-1', cloudCenterId: null,
    checkedAt: '2026-11-20T10:00:00.000Z', overallResult: 'satisfied', standardItemCount: 1,
  });
});

test('requires an applicable center and stores one selected center per execution', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: null };
      if (statement.startsWith('SELECT si.id')) return { rows: [ { id: 'item-1' } ], rowCount: 1 };
      if (statement.startsWith('SELECT center_name FROM supervision_definition_centers')) return { rows: [ { center_name: '云中心' } ], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_executions')) return { rows: [ { id: 'execution-2' } ], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_item_results')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new Repository({ connect: async () => client });
  const base = {
    projectId: 'project-1', definitionId: 'definition-1', checkedAt: '2026-11-20T10:00:00.000Z',
    checkedBy: 'user-1', overallResult: '', notes: '', itemResults: new Map(),
  };
  await assert.rejects(repository.create(base), error => error.code === 'INVALID_SUPERVISION_CENTER');
  await repository.create({ ...base, supervisionCenter: '云中心' });
  const insert = calls.find(call => call.statement.startsWith('INSERT INTO supervision_executions'));
  assert.equal(insert.values[3], '云中心');
});
