'use strict';

const DEFAULT_SUPERVISION_METHODS = [
  '证据材料核查',
  '上机查看',
  '访谈',
  '管理制度核查',
  '技术测试',
  '配置分析',
];

function splitSupervisionMethods(value) {
  const values = Array.isArray(value) ? value.flatMap(item => splitSupervisionMethods(item)) : String(value || '')
    .normalize('NFKC')
    .split(/[,，、;；\/|\r\n]+/)
    .map(item => item.trim())
    .filter(Boolean);
  return [ ...new Set(values) ];
}

function joinSupervisionMethods(value) {
  const order = new Map(DEFAULT_SUPERVISION_METHODS.map((method, index) => [ method, index ]));
  return splitSupervisionMethods(value).sort((left, right) => {
    const leftOrder = order.has(left) ? order.get(left) : Number.MAX_SAFE_INTEGER;
    const rightOrder = order.has(right) ? order.get(right) : Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.localeCompare(right, 'zh-CN');
  }).join(',');
}

module.exports = { DEFAULT_SUPERVISION_METHODS, joinSupervisionMethods, splitSupervisionMethods };
