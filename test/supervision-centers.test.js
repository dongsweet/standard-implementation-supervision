'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  supervisionCenterLabel,
  splitSupervisionCenters,
} = require('../app/lib/supervisionCenters');
const { normalizeDefinition, definitionConflicts } = require('../app/lib/dedupe');
const { planImportKey } = require('../app/repository/supervisionPlanImport');
const { buildObjectCandidates, objectCandidate, partitionSemanticCandidates } = require('../app/lib/centerObjectDedupe');

test('parses and canonicalizes multiple applicable supervision centers', () => {
  assert.deepEqual(splitSupervisionCenters('云中心，统一运维、总部；云中心'), [ '云中心', '统一运维中心', '总部' ]);
  assert.deepEqual(splitSupervisionCenters([ '云中心', '总部' ]), [ '云中心', '总部' ]);
  assert.deepEqual(splitSupervisionCenters('分支机构，统一运维机构、总部'), [ '云中心', '统一运维中心', '总部' ]);
});

test('presents legacy center values with branch terminology', () => {
  assert.equal(supervisionCenterLabel('云中心'), '分支机构');
  assert.equal(supervisionCenterLabel('统一运维中心'), '统一运维机构');
  assert.equal(supervisionCenterLabel('总部'), '总部');
  assert.equal(supervisionCenterLabel('新疆'), '新疆');
});

test('center differences do not change definition identity or create a metadata conflict', () => {
  const common = {
    object_name: '云平台账号', object_category: '技术', check_layer: '配置',
    check_method: '证据材料核查', description: '核查高权限账号', steps: '核对账号清单', frequency: '年度',
  };
  assert.equal(normalizeDefinition({ ...common, centers: [ '云中心' ] }).normalizedHash,
    normalizeDefinition({ ...common, centers: [ '统一运维中心' ] }).normalizedHash);
  assert.deepEqual(definitionConflicts(
    { ...common, scope: null, centers: [ '云中心' ] },
    { ...common, scope: null, centers: [ '统一运维中心' ] }
  ), []);
});

test('center object rule candidates distinguish punctuation variants from unrelated objects', () => {
  assert.deepEqual(objectCandidate('《采购合同或协议》', '采购合同或协议'), {
    candidateType: 'exact',
    similarity: 1,
  });
  const similar = objectCandidate('存储设备数据清理记录', '移动存储设备数据清理记录');
  assert.equal(similar.candidateType, 'similar');
  assert.ok(similar.similarity >= 0.6);
  assert.equal(objectCandidate('云平台', '堡垒机'), null);
});

test('center object rule candidates honor the user supplied similarity threshold', () => {
  assert.equal(objectCandidate('《安全设备通用操作规范》', '《安全设备通用操作规范》（网络隔离）', 0.75), null);
  assert.equal(
    objectCandidate('《安全设备通用操作规范》', '《安全设备通用操作规范》（网络隔离）', 0.7).candidateType,
    'similar'
  );
});

test('center object candidates stay within one center and dismiss reviewed pairs', () => {
  const candidates = buildObjectCandidates([
    { center_name: '总部', object_name: '《采购合同或协议》', plan_count: 1 },
    { center_name: '总部', object_name: '采购合同或协议', plan_count: 2 },
    { center_name: '云中心', object_name: '采购合同', plan_count: 1 },
    { center_name: '云中心', object_name: '采购合同模板', plan_count: 1 },
  ], [
    { center_name: '云中心', left_object_name: '采购合同', right_object_name: '采购合同模板', decision: 'distinct' },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].center_name, '总部');
  assert.equal(candidates[0].candidate_type, 'exact');
});

test('AI semantics annotate candidates without blocking manual review', () => {
  const candidates = [
    { id: 'exact', candidate_type: 'exact', ai: null, ai_status: 'pending' },
    { id: 'same', candidate_type: 'similar', ai: { relation: 'duplicate' }, ai_status: 'completed' },
    { id: 'opposite', candidate_type: 'similar', ai: { relation: 'similar_but_distinct' }, ai_status: 'completed' },
    { id: 'unknown', candidate_type: 'similar', ai: { relation: 'uncertain' }, ai_status: 'completed' },
    { id: 'pending', candidate_type: 'similar', ai: null, ai_status: 'pending' },
    { id: 'failed', candidate_type: 'similar', ai: null, ai_status: 'failed' },
  ];
  const result = partitionSemanticCandidates(candidates);
  assert.deepEqual(result.ruleCandidates.map(item => item.id), [ 'exact', 'same', 'opposite', 'unknown', 'pending', 'failed' ]);
  assert.deepEqual(result.aiDuplicate.map(item => item.id), [ 'same' ]);
  assert.deepEqual(result.aiExcluded.map(item => item.id), [ 'opposite' ]);
  assert.deepEqual(result.aiPending.map(item => item.id), [ 'exact', 'pending' ]);
  assert.deepEqual(result.aiFailed.map(item => item.id), [ 'failed' ]);
});

test('plan import identity keeps scope semantics but excludes applicable centers', () => {
  const fields = { scope: '生产环境', recognized_object: true, priority: '重点项' };
  assert.equal(planImportKey('hash', { ...fields, centers: [ '云中心' ] }),
    planImportKey('hash', { ...fields, centers: [ '总部' ] }));
  assert.notEqual(planImportKey('hash', fields), planImportKey('hash', { ...fields, scope: '测试环境' }));
});
