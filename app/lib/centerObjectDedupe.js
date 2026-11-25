'use strict';

const { normalizeText } = require('./dedupe');

const OBJECT_SIMILARITY_ALGORITHM_VERSION = 'object-normalized-lcs-v1';

function objectKey(value) {
  return normalizeText(value)
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function longestCommonSubsequenceLength(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
  if (a.length < b.length) return longestCommonSubsequenceLength(right, left);
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let leftIndex = 1; leftIndex <= a.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= b.length; rightIndex += 1) {
      current[rightIndex] = a[leftIndex - 1] === b[rightIndex - 1]
        ? previous[rightIndex - 1] + 1
        : Math.max(previous[rightIndex], current[rightIndex - 1]);
    }
    [ previous, current ] = [ current, previous ];
    current.fill(0);
  }
  return previous[b.length];
}

function objectSimilarity(left, right) {
  const a = objectKey(left);
  const b = objectKey(right);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  const commonLength = longestCommonSubsequenceLength(a, b);
  return (2 * commonLength) / (Array.from(a).length + Array.from(b).length);
}

function objectCandidate(leftObject, rightObject, threshold = 0.6) {
  const left = String(leftObject || '').trim();
  const right = String(rightObject || '').trim();
  if (!left || !right || left === right) return null;
  const leftKey = objectKey(left);
  const rightKey = objectKey(right);
  const score = objectSimilarity(left, right);
  if (leftKey === rightKey) {
    return { candidateType: 'exact', similarity: 1 };
  }
  if (score >= threshold) {
    return { candidateType: 'similar', similarity: score };
  }
  return null;
}

function pairKey(centerName, leftObject, rightObject) {
  return JSON.stringify([
    String(centerName || '').trim(),
    ...[ String(leftObject || '').trim(), String(rightObject || '').trim() ].sort(),
  ]);
}

function buildObjectCandidates(entries, reviews = [], threshold = 0.6) {
  const reviewsByPair = new Map(reviews.map(review => [
    pairKey(review.center_name, review.left_object_name, review.right_object_name),
    review,
  ]));
  const byCenter = new Map();
  for (const entry of entries) {
    if (!byCenter.has(entry.center_name)) byCenter.set(entry.center_name, []);
    byCenter.get(entry.center_name).push(entry);
  }
  const candidates = [];
  for (const [ centerName, centerEntries ] of byCenter) {
    for (let leftIndex = 0; leftIndex < centerEntries.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < centerEntries.length; rightIndex += 1) {
        const left = centerEntries[leftIndex];
        const right = centerEntries[rightIndex];
        const rule = objectCandidate(left.object_name, right.object_name, threshold);
        if (!rule) continue;
        const review = reviewsByPair.get(pairKey(centerName, left.object_name, right.object_name));
        if (review && [ 'merged', 'distinct', 'unrelated' ].includes(review.decision)) continue;
        candidates.push({
          center_name: centerName,
          left_object_name: left.object_name,
          right_object_name: right.object_name,
          left,
          right,
          candidate_type: rule.candidateType,
          similarity_score: rule.similarity,
          review: review || null,
        });
      }
    }
  }
  return candidates.sort((left, right) => {
    if (left.candidate_type !== right.candidate_type) return left.candidate_type === 'exact' ? -1 : 1;
    return right.similarity_score - left.similarity_score
      || left.center_name.localeCompare(right.center_name, 'zh-CN')
      || left.left_object_name.localeCompare(right.left_object_name, 'zh-CN');
  });
}

function partitionSemanticCandidates(candidates) {
  return {
    ruleCandidates: candidates,
    aiDuplicate: candidates.filter(candidate => candidate.ai?.relation === 'duplicate'),
    aiExcluded: candidates.filter(candidate =>
      candidate.ai?.relation === 'similar_but_distinct' || candidate.ai?.relation === 'unrelated'
    ),
    aiPending: candidates.filter(candidate =>
      !candidate.ai && candidate.ai_status !== 'failed'
    ),
    aiFailed: candidates.filter(candidate => candidate.ai_status === 'failed'),
  };
}

module.exports = {
  OBJECT_SIMILARITY_ALGORITHM_VERSION,
  buildObjectCandidates,
  objectCandidate,
  objectKey,
  objectSimilarity,
  pairKey,
  partitionSemanticCandidates,
};
