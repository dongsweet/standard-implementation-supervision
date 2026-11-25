'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  answerFrequency,
  coverageIssue,
  definitionIssues,
  evidenceCategory,
  frequenciesIn,
  objectCategoryIssue,
  standardFrequencies,
} = require('../app/lib/jointReviewRules');
const { parseJointReviewResult } = require('../app/lib/aiProvider');

function definition(overrides = {}) {
  return {
    id: 'definition-1',
    plan_number: 295,
    object_name: '业务防火墙',
    object_category: '业务平台',
    check_layer: '管理层面',
    check_method: '证据材料核查',
    description: '检查防火墙配置和整改记录',
    steps: '核对配置',
    frequency: '每月',
    access_mode: '现场',
    standard_items: [ {
      id: 'item-1',
      standard_number: '31168-2023-10037',
      title: '识别要求',
      content: '按照[赋值：云服务商定义的频率]，识别不必要或不安全的功能、端口、协议和服务；',
    } ],
    project_answers: [],
    ...overrides,
  };
}

test('extracts explicit frequencies from standards and project assignments', () => {
  assert.deepEqual(frequenciesIn('每月识别一次'), [ '每月' ]);
  assert.deepEqual(standardFrequencies([ { content: '每季度评审；事件触发时更新' } ]), [ '每季度', '不定期' ]);
  assert.deepEqual(answerFrequency({
    clause_assignment: '云服务商定义的频率：每月一次',
    assignment_details: [ { value: '每月' } ],
  }), [ '每月' ]);
});

test('distinguishes possible evidence materials from ordinary object categories', () => {
  assert.equal(evidenceCategory('业务平台'), false);
  assert.equal(evidenceCategory('业务平台、识别结果记录、配置项参数设置规程、配置管理计划等相关文档'), true);
  assert.equal(evidenceCategory('《配置管理审计报告》'), true);
});

test('flags mixed object categories for manual review', () => {
  const issue = objectCategoryIssue({
    canonical_name: '业务防火墙',
    master_category: '',
    plan_categories: [
      '业务平台',
      '业务平台、识别结果记录、配置项参数设置规程、配置管理计划等相关文档',
    ],
    plan_count: 25,
  });
  assert.equal(issue.reviewType, 'category_consistency');
  assert.equal(issue.severity, 'warning');
  assert.match(issue.summary, /历史方案中出现 2 种原始分类/);
  assert.equal(objectCategoryIssue({
    canonical_name: '单一对象',
    master_category: '技术',
    plan_categories: [ '技术' ],
  }), null);
});

test('detects frequency conflicts without treating matching frequency as a conflict', () => {
  assert.deepEqual(definitionIssues(definition()), []);
  const issue = definitionIssues(definition({
    frequency: '每年',
    project_answers: [ { clause_assignment: '云服务商定义的频率：每月一次' } ],
  })).find(item => item.reviewType === 'frequency_answer');
  assert.equal(issue.reviewType, 'frequency_answer');
  assert.match(issue.summary, /每年.*每月/);
});

test('detects missing plan links and excessive standard mixing', () => {
  const missing = definitionIssues(definition({ standard_items: [] }))[0];
  assert.equal(missing.reviewType, 'plan_standard');
  assert.equal(missing.severity, 'error');
  const mixed = definitionIssues(definition({ standard_items: [
    { id: '1', content: '要求一' },
    { id: '2', content: '要求二' },
    { id: '3', content: '要求三' },
  ] })).find(item => item.reviewType === 'plan_standard');
  assert.equal(mixed.severity, 'info');
  assert.match(mixed.ruleReason, /关联标准项数 3/);
});

test('creates coverage candidates only for applicable answers without plans', () => {
  assert.equal(coverageIssue({
    standard_number: '31168-2023-10037',
    applicability: 'applicable',
    linked_plan_count: 2,
    project_name: '多云统管',
  }), null);
  const issue = coverageIssue({
    standard_number: '31168-2023-10037',
    applicability: 'applicable',
    linked_plan_count: 0,
    project_name: '多云统管',
  });
  assert.equal(issue.reviewType, 'coverage');
  assert.match(issue.summary, /没有有效检查方案/);
});

test('validates structured joint review AI responses', () => {
  const result = parseJointReviewResult(JSON.stringify({
    verdict: 'multiple_objects',
    confidence: 0.88,
    severity: 'warning',
    summary: '对象可能是防火墙，其余为证据材料',
    evidence: [ '对象分类混入记录和规程' ],
    suggestedActions: [ '人工确认是否保留防火墙为检查对象' ],
    reason: '对象名称与检查内容关系需结合证据确认',
  }));
  assert.equal(result.verdict, 'multiple_objects');
  assert.equal(result.severity, 'warning');
  assert.equal(result.confidence, 0.88);
  assert.throws(
    () => parseJointReviewResult(JSON.stringify({ verdict: 'auto_fix', confidence: 1 })),
    /verdict 无效/
  );
});
