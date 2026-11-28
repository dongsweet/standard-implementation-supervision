'use strict';

const TERM_GROUPS = [
  [ 'edr', '终端检测与响应', '端点检测与响应', '终端安全', '端点安全', '杀毒', '防病毒', '反病毒', '病毒防护' ],
  [ '防火墙', '边界防护', '访问控制设备' ],
  [ '堡垒机', '运维审计', '运维堡垒机', '特权访问管理' ],
  [ '日志审计', '安全审计', '日志管理', '审计记录' ],
  [ '漏扫', '漏洞扫描', '脆弱性扫描' ],
  [ '备份', '数据备份', '备份恢复' ],
];

const STOP_WORDS = new Set([ '检查', '是否', '进行', '相关', '要求', '管理', '配置', '情况', '记录', '内容', '使用', '存在', '有效' ]);

function normalize(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function normalizedKey(value) {
  return normalize(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

function charBigrams(value) {
  const chars = Array.from(normalizedKey(value));
  if (chars.length < 2) return new Set(chars);
  const grams = new Set();
  for (let index = 0; index < chars.length - 1; index += 1) {
    grams.add(chars[index] + chars[index + 1]);
  }
  return grams;
}

function overlapRatio(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return (2 * intersection) / (left.size + right.size);
}

function termGroupsFor(value) {
  const key = normalizedKey(value);
  return TERM_GROUPS.filter(group => group.some(term => key.includes(normalizedKey(term))));
}

function planText(plan) {
  return [
    plan.object_name,
    plan.description,
    plan.steps,
    plan.check_method,
    ...(plan.standard_items || []).flatMap(item => [ item.title, item.content ]),
  ].filter(Boolean).join('\n');
}

function standardItemIds(plan) {
  return new Set((plan.standard_items || []).map(item => String(item.id || '')).filter(Boolean));
}

function chaptersFor(plan) {
  const chapters = new Map();
  for (const item of plan.standard_items || []) {
    const id = String(item.chapter_id || '');
    if (!id || chapters.has(id)) continue;
    chapters.set(id, {
      id,
      code: item.chapter_code || '',
      name: item.chapter_name || '',
    });
  }
  return chapters;
}

function candidateScore(left, right) {
  const reasons = [];
  const leftStandards = standardItemIds(left);
  const rightStandards = standardItemIds(right);
  const sharedStandards = [ ...leftStandards ].filter(id => rightStandards.has(id));
  if (sharedStandards.length) reasons.push('关联了相同标准项');

  const leftObjectKey = normalizedKey(left.master_object_name || left.object_name);
  const rightObjectKey = normalizedKey(right.master_object_name || right.object_name);
  const sameObject = Boolean(leftObjectKey && leftObjectKey === rightObjectKey);
  if (sameObject) reasons.push('检查对象相同');

  const sameCanonicalObject = left.object_id && left.object_id === right.object_id;
  if (!sameObject && sameCanonicalObject) reasons.push('规范对象相同');

  const leftGroups = termGroupsFor([ left.object_name, left.description ].join(' '));
  const rightGroups = termGroupsFor([ right.object_name, right.description ].join(' '));
  const sharedTermGroups = leftGroups.filter(group => rightGroups.includes(group));
  if (sharedTermGroups.length) reasons.push('名称或内容包含同义业务术语');

  const textSimilarity = overlapRatio(charBigrams(planText(left)), charBigrams(planText(right)));
  if (textSimilarity >= 0.45) reasons.push('检查内容文字相近');

  let score = textSimilarity * 0.45;
  if (sharedStandards.length) score += 0.4;
  if (sameObject) score += 0.25;
  else if (sameCanonicalObject) score += 0.2;
  if (sharedTermGroups.length) score += 0.35;
  return { score: Math.min(1, score), reasons, sharedStandardIds: sharedStandards, textSimilarity };
}

function compactPlan(plan) {
  return {
    id: plan.id,
    planNumber: plan.plan_number,
    objectName: plan.object_name,
    objectCategory: plan.object_category,
    masterObjectName: plan.master_object_name,
    checkLayer: plan.check_layer,
    checkMethod: plan.check_method,
    description: plan.description,
    steps: plan.steps,
    frequency: plan.frequency,
    accessMode: plan.access_mode,
    standardItems: (plan.standard_items || []).map(item => ({
      id: item.id,
      standardNumber: item.standard_number,
      itemCode: item.item_code,
      title: item.title,
      content: String(item.content || '').slice(0, 1600),
      chapterId: item.chapter_id,
      chapterCode: item.chapter_code,
      chapterName: item.chapter_name,
    })),
  };
}

function buildSemanticPairs(plans, { minimumScore = 0.35, limit = 80 } = {}) {
  const pairs = [];
  const seenPairs = new Set();
  for (let leftIndex = 0; leftIndex < plans.length; leftIndex += 1) {
    const left = plans[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < plans.length; rightIndex += 1) {
      const right = plans[rightIndex];
      const pairKey = [ left.id, right.id ].sort().join(':');
      if (seenPairs.has(pairKey)) continue;
      const chapters = new Map([ ...chaptersFor(left), ...chaptersFor(right) ]);
      const chapterIds = [ ...chapters.keys() ];
      const scored = candidateScore(left, right);
      if (scored.score < minimumScore) continue;
      seenPairs.add(pairKey);
      pairs.push({
        fingerprintSeed: pairKey,
        score: scored.score,
        recallReasons: scored.reasons,
        sharedStandardIds: scored.sharedStandardIds,
        chapterId: chapterIds[0] || '',
        chapterIds,
        chapters: [ ...chapters.values() ],
        left: compactPlan(left),
        right: compactPlan(right),
      });
    }
  }
  return pairs
    .sort((left, right) => right.score - left.score
      || String(left.left.planNumber).localeCompare(String(right.left.planNumber)))
    .slice(0, limit);
}

module.exports = {
  buildSemanticPairs,
  charBigrams,
  normalizedKey,
  overlapRatio,
  termGroupsFor,
};
