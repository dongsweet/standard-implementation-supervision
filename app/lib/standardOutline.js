'use strict';

function normalizeNumber(value) {
  return String(value || '').trim().normalize('NFKC');
}

function inferLevel(originalNumber, kind = 'heading') {
  const value = normalizeNumber(originalNumber);
  const numbered = value.match(/^(\d{1,3}(?:\.\d{1,3})*)(?:\s*(?:\(\d{1,3}\)|[A-Za-z][_)）]))?/);
  if (numbered) {
    const headingLevel = numbered[1].split('.').length;
    const hasListItem = numbered[0].length > numbered[1].length;
    return headingLevel + (hasListItem ? 1 : 0);
  }
  if (kind === 'list') return 4;
  return 1;
}

function recalculateHierarchy(nodes) {
  const stack = [];
  return nodes.map(node => {
    const level = inferLevel(node.originalNumber, node.kind);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parentId = stack.length ? stack[stack.length - 1].id : null;
    const result = { ...node, level, parentId };
    stack.push(result);
    return result;
  });
}

function descendantsOf(nodes, ancestorId) {
  const children = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!children.has(node.parentId)) children.set(node.parentId, []);
    children.get(node.parentId).push(node);
  }
  const result = [];
  const queue = [ ancestorId ];
  while (queue.length) {
    const parentId = queue.shift();
    for (const child of children.get(parentId) || []) {
      result.push(child);
      queue.push(child.id);
    }
  }
  return result;
}

module.exports = { descendantsOf, inferLevel, recalculateHierarchy };
