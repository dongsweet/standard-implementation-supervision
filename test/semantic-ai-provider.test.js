'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSemanticInspectionResults } = require('../app/lib/aiProvider');

const items = [
  {
    id: 'pair-1',
    left: { id: 'left-plan' },
    right: { id: 'right-plan' },
  },
];

test('parses structured semantic inspection comparison results', () => {
  const results = parseSemanticInspectionResults(JSON.stringify({
    results: [{
      id: 'pair-1',
      semanticRelation: 'same_check',
      confidence: 0.88,
      samePoints: [ '都要求终端部署恶意代码防护能力', '都由终端安全控制台核查' ],
      differences: [ '产品名称不同' ],
      reason: '两者检查对象和控制目的相同，名称差异属于术语差异。',
      recommendedKeepId: 'right-plan',
    }],
  }), items);
  assert.equal(results.length, 1);
  assert.equal(results[0].semanticRelation, 'same_check');
  assert.equal(results[0].recommendedKeepId, 'right-plan');
  assert.equal(results[0].samePoints.length, 2);
});

test('drops unsupported semantic relation values and keep ids', () => {
  assert.throws(() => parseSemanticInspectionResults(JSON.stringify({
    results: [{
      id: 'pair-1',
      semanticRelation: 'definitely_same',
      confidence: 0.9,
      recommendedKeepId: 'other-plan',
    }],
  }), items), /没有有效检查项语义判断/);
});
