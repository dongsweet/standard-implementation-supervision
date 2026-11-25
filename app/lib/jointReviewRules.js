'use strict';

const FREQUENCY_TERMS = [
  [ '每日', /每日|每天|按日/ ],
  [ '每周', /每周|按周/ ],
  [ '每月', /每月|按月|月度/ ],
  [ '每季度', /每季度|按季度|季度/ ],
  [ '每半年', /每半年|半年/ ],
  [ '每年', /每年|按年|年度/ ],
  [ '不定期', /不定期|事件触发|按需/ ],
  [ '仅一次', /仅一次|一次性/ ],
];

const EVIDENCE_TERMS = /记录|报告|清单|列表|台账|日志|截图|文档|材料|通知|邮件|合同|协议|规程|计划|方案|工单|凭证|审批表|登记表/;

function frequenciesIn(value) {
  const text = String(value || '');
  return FREQUENCY_TERMS.filter(([, pattern ]) => pattern.test(text)).map(([ label ]) => label);
}

function answerFrequency(answer = {}) {
  const values = [
    answer.clause_assignment,
    answer.compliance_description,
    JSON.stringify(answer.assignment_details || []),
  ];
  return Array.from(new Set(values.flatMap(frequenciesIn)));
}

function standardFrequencies(standardItems = []) {
  return Array.from(new Set(standardItems.flatMap(item =>
    frequenciesIn([ item.title, item.content, item.explanation ].filter(Boolean).join('\n'))
  )));
}

function evidenceCategory(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const tokens = text.split(/[、,，;；/|]/).map(item => item.trim()).filter(Boolean);
  return EVIDENCE_TERMS.test(text) || tokens.length >= 3;
}

function definitionIssues(definition) {
  const issues = [];
  const standards = definition.standard_items || [];
  if (!standards.length) {
    issues.push({
      reviewType: 'plan_standard',
      severity: 'error',
      title: `方案 ${definition.plan_number || ''} 未关联标准项`,
      summary: '检查方案没有可追溯的标准项，无法核对要求来源。',
      ruleReason: '检查方案与标准项关联数为 0。',
    });
  } else if (standards.length >= 3) {
    issues.push({
      reviewType: 'plan_standard',
      severity: 'info',
      title: `方案 ${definition.plan_number || ''} 关联了 ${standards.length} 个标准项`,
      summary: '一个方案关联了多个标准项，需要确认这些要求是否属于同一检查动作。',
      ruleReason: `关联标准项数 ${standards.length}，达到复核阈值 3。`,
    });
  }

  if (evidenceCategory(definition.object_category)
    || (EVIDENCE_TERMS.test(definition.object_name) && EVIDENCE_TERMS.test(definition.description))) {
    issues.push({
      reviewType: 'object_content',
      severity: 'warning',
      title: `方案 ${definition.plan_number || ''} 的检查对象与内容关系需确认`,
      summary: '检查对象可能与记录、文档或证据材料混写；也可能是正常的“对象 + 证据”关系。',
      ruleReason: `对象分类为“${definition.object_category || '未分类'}”，检查对象为“${definition.object_name}”。`,
    });
  }

  const planned = frequenciesIn(definition.frequency);
  const standardRequired = new Set(standardFrequencies(standards));
  const answerRequired = new Set(
    (definition.project_answers || []).flatMap(answer => answerFrequency(answer))
  );
  const conflicts = target => planned.length && target.size && !planned.some(value => target.has(value));
  if (conflicts(standardRequired) || conflicts(answerRequired)) {
    const required = new Set([ ...standardRequired, ...answerRequired ]);
    issues.push({
      reviewType: 'frequency_answer',
      severity: 'warning',
      title: `方案 ${definition.plan_number || ''} 的执行频率与标准要求不一致`,
      summary: `方案频率为“${planned.join('、')}”，标准或项目应答中的频率为“${Array.from(required).join('、')}”。`,
      ruleReason: '方案频率与标准要求或项目赋值频率没有交集，需要区分标准执行频率与监督检查频率。',
    });
  }
  return issues;
}

function objectCategoryIssue(object) {
  const categories = (object.plan_categories || []).filter(Boolean);
  if (categories.length < 2 && (!object.master_category || !categories.some(value => value !== object.master_category))) {
    return null;
  }
  return {
    reviewType: 'category_consistency',
    severity: categories.some(evidenceCategory) ? 'warning' : 'info',
    title: `对象“${object.canonical_name}”的分类方向不一致`,
    summary: object.master_category
      ? `规范分类为“${object.master_category}”，历史方案中还出现 ${categories.length} 种原始分类。`
      : `规范对象尚未分类，历史方案中出现 ${categories.length} 种原始分类。`,
    ruleReason: `历史方案原始分类：${categories.join('；') || '无'}。`,
  };
}

function coverageIssue(item) {
  if (item.applicability !== 'applicable' || Number(item.linked_plan_count) > 0) return null;
  return {
    reviewType: 'coverage',
    severity: 'warning',
    title: `标准项 ${item.standard_number || item.item_code} 已适用但没有检查方案`,
    summary: '项目应答已确认该标准项适用，但当前没有有效检查方案关联该标准项。',
    ruleReason: `项目 ${item.project_name} 的应答适用性为 applicable，关联有效方案数为 0。`,
  };
}

function issueContextHash(issue, context) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(JSON.stringify({ issue, context })).digest('hex');
}

module.exports = {
  answerFrequency,
  coverageIssue,
  definitionIssues,
  evidenceCategory,
  frequenciesIn,
  issueContextHash,
  objectCategoryIssue,
  standardFrequencies,
};
