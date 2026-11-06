'use strict';

const STANDARD_TYPES = [
  { value: 'national', label: '国家标准' },
  { value: 'industry', label: '行业标准' },
  { value: 'local', label: '地方标准' },
  { value: 'group', label: '团体标准' },
  { value: 'enterprise', label: '企业标准' },
  { value: 'internal', label: '企业内部制度/规范' },
  { value: 'regulatory', label: '监管要求' },
  { value: 'other', label: '其他' },
];

const STANDARD_TYPE_LABELS = Object.fromEntries(STANDARD_TYPES.map(item => [ item.value, item.label ]));

module.exports = { STANDARD_TYPES, STANDARD_TYPE_LABELS };
