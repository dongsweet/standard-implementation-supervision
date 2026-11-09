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
    standardLevel: '增强要求',
    isKey: true,
    clauseAssignment: '7天；禁用',
    unifiedRequirement: '临时账号默认7天，到期自动禁用。',
    expectedEvidence: '账号管理制度、配置截图',
    applicability: 'applicable',
    applicabilityScope: '抚州政务云、新疆政务云',
    status: 'partially_satisfied',
    actualEvidence: '账号管理制度、堡垒机配置截图',
    measureDescription: '已统一账号策略，两个云中心完成配置。',
    problemDescription: '新疆云中心双人复核待补证。',
    ownerUserId: 'user-1',
  });

  assert.equal(result.id, 'answer-1');
  assert.match(queries[0].sql, /standard_level, is_key, clause_assignment, unified_requirement/);
  assert.deepEqual(queries[0].values, [
    'project-1',
    'item-1',
    '增强要求',
    true,
    '7天；禁用',
    '临时账号默认7天，到期自动禁用。',
    '账号管理制度、配置截图',
    'applicable',
    '抚州政务云、新疆政务云',
    'partially_satisfied',
    '账号管理制度、堡垒机配置截图',
    '已统一账号策略，两个云中心完成配置。',
    '新疆云中心双人复核待补证。',
    'user-1',
  ]);
});
