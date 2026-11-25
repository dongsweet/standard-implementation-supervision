'use strict';

const DEFAULT_SUPERVISION_CENTERS = [ '云中心', '统一运维中心', '总部' ];

const SUPERVISION_CENTER_LABELS = Object.freeze({
  云中心: '分支机构',
  统一运维中心: '统一运维机构',
  总部: '总部',
});

function supervisionCenterLabel(value) {
  return SUPERVISION_CENTER_LABELS[value] || value || '';
}

function splitSupervisionCenters(value) {
  const values = Array.isArray(value) ? value : [ value ];
  const result = [];
  for (const item of values) {
    String(item || '').normalize('NFKC')
      .split(/[,，、;；/|\r\n]+/)
      .map(part => part.trim())
      .filter(Boolean)
      .forEach(part => {
        const normalized = part.replace(/(?:中心|机构)$/, '');
        const canonical = [ '云中心', '云', '分支机构', '分支' ].includes(normalized) ? '云中心'
          : [ '统一运维中心', '统一运维', '统一运维机构' ].includes(normalized) ? '统一运维中心'
            : normalized === '总部' ? '总部' : part;
        if (!result.includes(canonical)) result.push(canonical);
      });
  }
  return result;
}

module.exports = {
  DEFAULT_SUPERVISION_CENTERS,
  SUPERVISION_CENTER_LABELS,
  supervisionCenterLabel,
  splitSupervisionCenters,
};
