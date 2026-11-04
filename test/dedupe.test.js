'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDefinition, scoreDefinition } = require('../app/lib/dedupe');
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

test('validates structured AI result', () => {
  const result = parseAiResult('{"relation":"duplicate","confidence":0.91,"differences":[],"reason":"等价"}');
  assert.equal(result.relation, 'duplicate');
  assert.equal(result.confidence, 0.91);
  assert.throws(() => parseAiResult('{"relation":"bad","confidence":2}'));
});
