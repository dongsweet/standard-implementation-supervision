'use strict';

const fs = require('node:fs');
const { buildAnswerAssignmentDetails } = require('../app/lib/projectWorkbookImport');

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const output = {};
for (const [ number, rows ] of Object.entries(input.details)) {
  output[number] = buildAnswerAssignmentDetails(
    rows.map(row => ({
      type: row.extractionType,
      placeholder: row.placeholder,
      label: row.label,
      rawCurrentAssignment: row.rawCurrentAssignment,
      currentAssignment: row.mappedValue || row.currentAssignment,
      hasMappedValue: row.review === '是'
        ? false
        : Boolean(row.mappedValue) || row.active === '否'
          || Boolean(row.active && /已完成映射/.test(row.extractionStatus || '')),
      placeholderId: row.placeholderId,
      explicitPlaceholderId: true,
      parentSelectionId: row.parentSelectionId || null,
      isActive: row.active === '是' ? true : row.active === '否' ? false : null,
      sourceRow: row.sourceRow,
      needsReview: row.review === '是',
      reviewReason: row.reviewReason,
    })),
    input.summaries[number]?.assignmentText || '',
    input.contents[number] || ''
  );
}
fs.writeFileSync(process.argv[3], JSON.stringify(output));
