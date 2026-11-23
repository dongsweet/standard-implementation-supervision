'use strict';

const DEFAULT_SUPERVISION_CENTERS = [ '云中心', '统一运维中心', '总部' ];

function splitSupervisionCenters(value) {
  const values = Array.isArray(value) ? value : [ value ];
  const result = [];
  for (const item of values) {
    String(item || '').normalize('NFKC')
      .split(/[,，、;；/|\r\n]+/)
      .map(part => part.trim())
      .filter(Boolean)
      .forEach(part => {
        const normalized = part.replace(/中心$/, '');
        const canonical = normalized === '云' ? '云中心'
          : normalized === '统一运维' ? '统一运维中心'
            : normalized === '总部' ? '总部' : part;
        if (!result.includes(canonical)) result.push(canonical);
      });
  }
  return result;
}

module.exports = { DEFAULT_SUPERVISION_CENTERS, splitSupervisionCenters };
