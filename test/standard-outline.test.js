'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { descendantsOf, inferLevel, recalculateHierarchy } = require('../app/lib/standardOutline');

test('infers hierarchy from corrected standard numbers', () => {
  assert.equal(inferLevel('5'), 1);
  assert.equal(inferLevel('5.1'), 2);
  assert.equal(inferLevel('5.1.1'), 3);
  assert.equal(inferLevel('5.1.1 a)'), 4);
  assert.equal(inferLevel('5.1.1 (1)', 'list'), 4);
});

test('recalculates parents after a number edit and supports subtree skipping', () => {
  const nodes = recalculateHierarchy([
    { id: 'a', kind: 'heading', originalNumber: '5', title: '安全要求' },
    { id: 'b', kind: 'heading', originalNumber: '5.1', title: '分类' },
    { id: 'c', kind: 'list', originalNumber: '5.1 a)', content: '第一项' },
    { id: 'd', kind: 'heading', originalNumber: '5.2', title: '表述' },
  ]);
  assert.equal(nodes[0].level, 1);
  assert.equal(nodes[1].parentId, 'a');
  assert.equal(nodes[2].parentId, 'b');
  assert.equal(nodes[3].parentId, 'a');

  const corrected = recalculateHierarchy(nodes.map(node => {
    if (node.id === 'b') return { ...node, originalNumber: '5.1.1' };
    if (node.id === 'c') return { ...node, originalNumber: '5.1.1 a)' };
    return node;
  }));
  assert.equal(corrected[1].level, 3);
  assert.equal(corrected[1].parentId, 'a');
  assert.equal(corrected[2].parentId, 'b');
  assert.deepEqual(descendantsOf(corrected, 'a').map(node => node.id), [ 'b', 'd', 'c' ]);
});
