'use strict';

const { normalizeText } = require('../lib/dedupe');

function buildSplitGroups(plans) {
  const groups = new Map();
  for (const plan of plans || []) {
    const category = String(plan.object_category || '').trim() || '未分类';
    if (!groups.has(category)) {
      groups.set(category, {
        category,
        planIds: [],
        planNumbers: [],
      });
    }
    const group = groups.get(category);
    group.planIds.push(plan.id);
    group.planNumbers.push(plan.plan_number);
  }
  return Array.from(groups.values())
    .map(group => ({
      ...group,
      planNumbers: group.planNumbers.sort((left, right) => Number(left) - Number(right)),
      suggestedName: '',
    }))
    .sort((left, right) => right.planIds.length - left.planIds.length
      || left.category.localeCompare(right.category, 'zh-CN'));
}

function validateSplitDraft({ sourceName, groups }) {
  const errors = [];
  const normalizedSource = normalizeText(sourceName);
  const names = new Set();
  const assignedPlans = new Set();
  const validGroups = [];
  for (const [index, group] of (groups || []).entries()) {
    const name = String(group.name || '').trim();
    const category = String(group.category || '').trim();
    const planIds = Array.from(new Set((group.planIds || []).map(String)));
    if (!name) errors.push(`第 ${index + 1} 组缺少新对象名称`);
    if (!category) errors.push(`第 ${index + 1} 组缺少分类`);
    if (!planIds.length) errors.push(`第 ${index + 1} 组没有检查方案`);
    const normalizedName = normalizeText(name);
    if (normalizedName && normalizedName === normalizedSource) {
      errors.push(`新对象名称不能与来源对象“${sourceName}”相同`);
    }
    if (normalizedName && names.has(normalizedName)) errors.push(`新对象名称重复：${name}`);
    names.add(normalizedName);
    for (const planId of planIds) {
      if (assignedPlans.has(planId)) errors.push(`检查方案 ${planId} 被分配到多个分组`);
      assignedPlans.add(planId);
    }
    validGroups.push({ name, category, planIds });
  }
  if (validGroups.length < 2) errors.push('拆分至少需要两个目标对象');
  return {
    errors: Array.from(new Set(errors)),
    groups: validGroups,
    assignedPlanCount: assignedPlans.size,
  };
}

module.exports = { buildSplitGroups, validateSplitDraft };
