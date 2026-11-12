'use strict';

function normalizeReviewText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；：、,.!?！？;:'"“”‘’()（）\[\]【】《》<>—_\-\/|\\]/g, '');
}

function trivialReason(value) {
  const normalized = normalizeReviewText(value).toLowerCase();
  if (!normalized) return '正文为空';
  if (normalized.length <= 3) return '正文仅含短标记或默认值';
  if (/^(?:无|x+|默认无)$/.test(normalized)) return '内容为无/默认无标记';
  if (/^无\d*(?:gbt?\d{5}(?:[-—一]?\d{4})|gb\d{5}(?:[-—一]?\d{4}))?$/.test(normalized)) return '内容为无及页眉页脚噪声';
  if (/^(?:gbt?\d{5}(?:[-—一]?\d{4})|gb\d{5}(?:[-—一]?\d{4}))$/.test(normalized)) return '内容仅为页眉页脚噪声';
  return '';
}

function buildChildren(nodes) {
  const children = new Map();
  for (const node of nodes || []) {
    if (!node?.parentId) continue;
    if (!children.has(node.parentId)) children.set(node.parentId, []);
    children.get(node.parentId).push(node);
  }
  return children;
}

function hasDescendants(children, nodeId) {
  const queue = [ nodeId ];
  while (queue.length) {
    const parentId = queue.shift();
    const direct = children.get(parentId) || [];
    if (direct.length) return true;
    queue.push(...direct.map(node => node.id));
  }
  return false;
}

function reviewableNode(node) {
  return Boolean(node && (node.kind === 'heading' || node.kind === 'list'));
}

function buildRuleRecommendations(nodes, { afterIndex = -1, endIndex = (nodes || []).length } = {}) {
  const children = buildChildren(nodes);
  const recommendations = [];
  for (let index = Math.max(0, afterIndex + 1); index < Math.min(endIndex, (nodes || []).length); index += 1) {
    const node = nodes[index];
    if (!reviewableNode(node)) continue;
    const descendant = hasDescendants(children, node.id);
    if (descendant) {
      if (node.role !== 'container') {
        recommendations.push({
          nodeId: node.id,
          action: 'container',
          confidence: 1,
          reason: '该节点存在子节点，应作为章节/容器。',
        });
      }
      continue;
    }
    const reason = trivialReason(node.content);
    if (reason && node.role !== 'skip') {
      recommendations.push({
        nodeId: node.id,
        action: 'skip',
        confidence: 1,
        reason,
      });
    }
  }
  return recommendations;
}

function unresolvedNode(node) {
  if (!reviewableNode(node) || !String(node.content || '').trim()) return false;
  return Boolean(
    node.comparisonMatch !== 'matched'
    || node.comparisonMarkerConflict
    || !node.comparisonContent
  );
}

function buildAiCandidates(nodes, { afterIndex = -1, endIndex = (nodes || []).length } = {}) {
  const children = buildChildren(nodes);
  const result = [];
  for (let index = Math.max(0, afterIndex + 1); index < Math.min(endIndex, (nodes || []).length); index += 1) {
    const node = nodes[index];
    if (!unresolvedNode(node)) continue;
    if (hasDescendants(children, node.id)) continue;
    if (trivialReason(node.content)) continue;
    result.push({
      id: node.id,
      originalNumber: String(node.originalNumber || '').trim(),
      title: String(node.title || '').trim(),
      content: String(node.content || '').trim(),
      ocrContent: String(node.ocrContent || node.content || '').trim(),
      comparisonContent: String(node.comparisonContent || '').trim(),
      comparisonItemCode: String(node.comparisonItemCode || '').trim(),
      comparisonMatch: node.comparisonMatch || '',
      comparisonMarkerConflict: Boolean(node.comparisonMarkerConflict),
    });
  }
  return result;
}

function findAfterIndex(nodes, afterOriginalNumber) {
  const needle = String(afterOriginalNumber || '').trim().normalize('NFKC');
  if (!needle) return -1;
  let index = -1;
  for (let cursor = 0; cursor < (nodes || []).length; cursor += 1) {
    if (String(nodes[cursor].originalNumber || '').trim().normalize('NFKC') === needle) index = cursor;
  }
  return index;
}

function rootChapterNumber(value) {
  const match = String(value || '').normalize('NFKC').match(/^(\d{1,3})(?:\.|$)/);
  return match ? match[1] : '';
}

function findScopeEndIndex(nodes, afterOriginalNumber, afterIndex) {
  if (afterIndex < 0 || !String(afterOriginalNumber || '').trim()) return (nodes || []).length;
  const root = rootChapterNumber(afterOriginalNumber);
  if (!root) return (nodes || []).length;
  const rootNumber = Number(root);
  for (let index = afterIndex + 1; index < (nodes || []).length; index += 1) {
    const nodeRoot = rootChapterNumber(nodes[index]?.originalNumber);
    if (nodeRoot && nodeRoot !== root && Number(nodeRoot) > rootNumber) return index;
  }
  return (nodes || []).length;
}

module.exports = {
  buildAiCandidates,
  buildRuleRecommendations,
  findAfterIndex,
  findScopeEndIndex,
  normalizeReviewText,
  trivialReason,
};
