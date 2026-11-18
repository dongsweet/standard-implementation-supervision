'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ProjectRepository = require('../app/repository/project');

test('saves project applicability and evidence separately from satisfaction status', async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
      return { rows: [ { id: 'answer-1' } ], rowCount: 1 };
    },
  };
  const repository = new ProjectRepository(pool);
  const result = await repository.saveAnswer({
    projectId: 'project-1',
    standardItemId: 'item-1',
    isKey: true,
    clauseAssignment: '7天；禁用',
    assignmentDetails: [ {
      type: 'selection', label: '选择', placeholderId: 'selection:1',
      selectedValues: [ '7天' ], value: '7天', selected: true, parentSelectionId: null,
    } ],
    complianceDescription: '临时账号默认7天，到期自动禁用。',
    expectedEvidence: '账号管理制度、配置截图',
    applicability: 'applicable',
    status: 'partially_satisfied',
    actualEvidence: '账号管理制度、堡垒机配置截图',

    answerNotes: '新疆云中心双人复核待补证。',
    ownerUserId: 'user-1',
  });

  assert.equal(result.id, 'answer-1');
  assert.match(queries[0].sql, /clause_assignment, assignment_details/);
  assert.match(queries[0].sql, /compliance_description/);
  assert.match(queries[0].sql, /answer_notes/);
  assert.deepEqual(queries[0].values, [
    'project-1',
    'item-1',
    true,
    '7天；禁用',
    JSON.stringify([ {
      type: 'selection', label: '选择', placeholderId: 'selection:1',
      selectedValues: [ '7天' ], value: '7天', selected: true, parentSelectionId: null,
    } ]),
    '临时账号默认7天，到期自动禁用。',
    '账号管理制度、配置截图',
    'applicable',
    'partially_satisfied',
    '账号管理制度、堡垒机配置截图',
    '新疆云中心双人复核待补证。',
    'user-1',
  ]);
});
