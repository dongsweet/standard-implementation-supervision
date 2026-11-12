'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAiCandidates,
  buildRuleRecommendations,
  findAfterIndex,
  findScopeEndIndex,
  trivialReason,
} = require('../app/lib/standardReview');

test('builds deterministic container and skip recommendations after a checkpoint', () => {
  const nodes = [
    { id: 'n1', originalNumber: '6.6.3', kind: 'heading', role: 'container', content: '' },
    { id: 'n2', originalNumber: '6.7', kind: 'heading', role: 'item', content: '', parentId: null },
    { id: 'n3', originalNumber: '6.7.1', kind: 'heading', role: 'item', content: '无。', parentId: 'n2' },
    { id: 'n4', originalNumber: '6.7.2', kind: 'heading', role: 'item', content: '云服务商应满足以下要求。', parentId: 'n2' },
    { id: 'n5', originalNumber: '6.7.2 a)', kind: 'list', role: 'item', content: '有效条款', parentId: 'n4' },
  ];
  const afterIndex = findAfterIndex(nodes, '6.6.3');
  assert.equal(findScopeEndIndex([
    ...nodes,
    { id: 'n6', originalNumber: '7', kind: 'heading' },
  ], '6.6.3', afterIndex), 5);
  const result = buildRuleRecommendations(nodes, { afterIndex });
  assert.deepEqual(result.map(item => [ item.nodeId, item.action ]), [
    [ 'n2', 'container' ],
    [ 'n3', 'skip' ],
    [ 'n4', 'container' ],
  ]);
  assert.equal(buildAiCandidates(nodes, { afterIndex }).map(item => item.id).join(','), 'n5');
});

test('recognizes short defaults and OCR page-header noise', () => {
  assert.ok(trivialReason('默认：无'));
  assert.ok(trivialReason('无8 GB/T 31168一2023'));
  assert.ok(trivialReason('X'));
  assert.equal(trivialReason('制定并实施安全策略'), '');
});
