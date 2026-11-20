'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { definitionConflicts, normalizeDefinition, scoreDefinition } = require('../app/lib/dedupe');
const { parseAiResult } = require('../app/lib/aiProvider');

test('normalizes full-width punctuation and whitespace deterministically', () => {
  const one = normalizeDefinition({ object_name: '云平台', check_method: '证据材料核查', description: '检查  制度。', steps: '步骤一', object_category: '制度', check_layer: '管理', frequency: '年度' });
  const two = normalizeDefinition({ object_name: '云平台', check_method: '证据材料核查', description: '检查 制度', steps: '步骤一', object_category: '制度', check_layer: '管理', frequency: '年度' });
  assert.equal(one.normalizedHash, two.normalizedHash);
});

test('scores equivalent definitions higher than unrelated definitions', () => {
  const a = normalizeDefinition({ object_name: '安全制度', object_category: '制度', check_layer: '管理', check_method: '证据核查', description: '核查制度是否有效', steps: '查阅制度文件', frequency: '年度' });
  const b = normalizeDefinition({ object_name: '安全制度', object_category: '制度', check_layer: '管理', check_method: '证据核查', description: '检查制度是否有效', steps: '查阅制度文件', frequency: '年度' });
  const c = normalizeDefinition({ object_name: '机房环境', object_category: '现场', check_layer: '技术', check_method: '现场查看', description: '检查温湿度', steps: '进入机房查看', frequency: '季度' });
  assert.ok(scoreDefinition(a, b) > scoreDefinition(a, c));
});

test('detects content and metadata conflicts before merging definitions', () => {
  const left = { object_name: '网络拓扑', description: '检查拓扑', scope: '云中心', recognized_object: true, priority: '重点项', access_mode: '远程' };
  const right = { object_name: '安全架构', description: '检查架构', scope: '总部', recognized_object: false, priority: '非重点项', access_mode: '现场' };
  assert.deepEqual(definitionConflicts(left, right), [
    [ 'object_name', '检查对象' ],
    [ 'description', '检查项描述' ],
    [ 'access_mode', '执行方式' ],
    [ 'scope', '检查范围' ],
    [ 'recognized_object', '是否公认对象' ],
    [ 'priority', '重点项' ],
  ]);
});

test('validates structured AI result', () => {
  const result = parseAiResult('{"relation":"duplicate","confidence":0.91,"differences":[],"reason":"等价"}');
  assert.equal(result.relation, 'duplicate');
  assert.equal(result.confidence, 0.91);
  assert.throws(() => parseAiResult('{"relation":"bad","confidence":2}'));
});
