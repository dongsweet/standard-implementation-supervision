'use strict';

const ExcelJS = require('exceljs');

const SUMMARY_HEADERS = [
  '标准化编号',
  '条款号',
  '项目表序号(A列)',
  '是否重点项',
  '应答赋值',
  '制度符合性描述',
  '所需证据',
  '实际证据',
  '适用性标记',
  '符合性标记',
  '备注',
];

const DETAIL_HEADERS = [
  '标准化编号',
  '条款号',
  '提取类型',
  '需赋值项或选择项',
  '原文占位符',
  '占位符ID',
  '所属选择项ID',
  '是否选中/生效',
  '对应占位符的当前值',
  '原始当前赋值（导入）',
  '需要复核',
  '复核原因',
];

const APPLICABILITY_LABELS = {
  unspecified: '未标记',
  applicable: '适用',
  not_applicable: '不适用',
};

const STATUS_LABELS = {
  unassessed: '未标记',
  satisfied: '符合',
  partially_satisfied: '部分符合',
  not_satisfied: '不符合',
};

function text(value) {
  return String(value ?? '').trim();
}

function styleHeader(row) {
  row.height = 28;
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF28744A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFB7D8C5' } } };
  });
}

function setColumns(worksheet, widths) {
  widths.forEach((width, index) => {
    worksheet.getColumn(index + 1).width = width;
  });
}

function addInstructionSheet(workbook) {
  const sheet = workbook.addWorksheet('填写说明', { views: [ { state: 'frozen', ySplit: 1 } ] });
  sheet.addRow([ '项目应答导入模板填写说明' ]);
  sheet.mergeCells('A1:B1');
  sheet.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FF1F4D36' } };
  sheet.getCell('A1').alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 30;
  const rows = [
    [ '工作表', '用途' ],
    [ '应答汇总', '每条标准项的最终应答。标准化编号已按当前项目预填；条款号只用于人工核对。' ],
    [ '赋值明细', '仅当标准原文包含[赋值：...]或[选择：...]时填写。没有占位符的条款不要填写。' ],
    [ '标准化编号', '必须使用“应答汇总”中已预填的编号。不要修改编号。' ],
    [ '适用性标记', '可填：未标记、适用、不适用。留空按“未标记”处理。' ],
    [ '符合性标记', '可填：未标记、符合、部分符合、不符合。留空按“未标记”处理。' ],
    [ '是否重点项', '可填：是、否。留空时保留系统现有值。' ],
    [ '应答赋值', '结构化占位符的最终摘要；系统会根据“赋值明细”重新生成并校验。' ],
    [ '赋值明细', '一行对应一个选择项或赋值项；“是否选中/生效”填“是”或“否”。' ],
    [ '多选', '同一选择项的多个选中值可填在“对应占位符的当前值”中，用中文分号“；”分隔。' ],
    [ '空白行', '未填写任何应答字段的标准项不会导入。' ],
    [ '占位符规则', '只提交已选分支及其赋值；未选分支请将“是否选中/生效”填“否”，不要填写当前值。' ],
  ];
  rows.forEach((values, index) => {
    const row = sheet.addRow(values);
    if (index === 0) styleHeader(row);
    else row.alignment = { vertical: 'top', wrapText: true };
  });
  setColumns(sheet, [ 22, 92 ]);
  sheet.autoFilter = 'A1:B1';
}

function addSummarySheet(workbook, rows) {
  const sheet = workbook.addWorksheet('应答汇总', { views: [ { state: 'frozen', ySplit: 1 } ] });
  sheet.addRow(SUMMARY_HEADERS);
  styleHeader(sheet.getRow(1));
  for (const row of rows) {
    sheet.addRow([
      text(row.standardNumber || row.standard_number_snapshot || row.standard_number),
      text(row.clauseNumber || row.itemCode || row.item_code_snapshot),
      text(row.projectSequence),
      row.isKey === true ? '是' : row.isKey === false ? '否' : '',
      text(row.assignmentText || row.clause_assignment),
      text(row.complianceDescription || row.compliance_description),
      text(row.expectedEvidence || row.expected_evidence),
      text(row.actualEvidence || row.actual_evidence),
      row.applicability === 'applicable' || row.applicability === 'not_applicable'
        ? APPLICABILITY_LABELS[row.applicability]
        : '',
      row.answerStatus && row.answerStatus !== 'unassessed'
        ? STATUS_LABELS[row.answerStatus]
        : '',
      text(row.answerNotes || row.answer_notes),
    ]);
  }
  const dataEnd = Math.max(2, sheet.rowCount);
  for (let rowNumber = 2; rowNumber <= dataEnd; rowNumber += 1) {
    sheet.getRow(rowNumber).alignment = { vertical: 'top', wrapText: true };
  }
  setColumns(sheet, [ 23, 14, 17, 12, 38, 52, 28, 38, 13, 13, 32 ]);
  sheet.autoFilter = 'A1:K1';
  sheet.dataValidations.add(`D2:D${dataEnd}`, {
    type: 'list', allowBlank: true, formulae: [ '"是,否"' ],
  });
  sheet.dataValidations.add(`I2:I${dataEnd}`, {
    type: 'list', allowBlank: true, formulae: [ '"未标记,适用,不适用"' ],
  });
  sheet.dataValidations.add(`J2:J${dataEnd}`, {
    type: 'list', allowBlank: true, formulae: [ '"未标记,符合,部分符合,不符合"' ],
  });
  return sheet;
}

function detailRowsForAnswer(answer) {
  return (answer.assignmentDetails || answer.assignment_details || []).map(detail => ({
    standardNumber: answer.standardNumber || answer.standard_number_snapshot || answer.standard_number,
    clauseNumber: answer.clauseNumber || answer.itemCode || answer.item_code_snapshot,
    extractionType: detail.type === 'selection' ? '选择' : '赋值',
    label: detail.label,
    placeholder: detail.placeholder,
    placeholderId: detail.placeholderId,
    parentSelectionId: detail.parentSelectionId || '',
    active: detail.selected === false ? '否' : '是',
    currentValue: detail.type === 'selection'
      ? (detail.selectedValues || []).join('；') || detail.value
      : detail.value,
    rawCurrentValue: detail.rawCurrentAssignment || '',
    review: detail.reviewRequired ? '是' : '否',
    reviewReason: detail.reviewReason || '',
  }));
}

function addDetailSheet(workbook, answerRows) {
  const sheet = workbook.addWorksheet('赋值明细', { views: [ { state: 'frozen', ySplit: 1 } ] });
  sheet.addRow(DETAIL_HEADERS);
  styleHeader(sheet.getRow(1));
  for (const answer of answerRows) {
    for (const row of detailRowsForAnswer(answer)) {
      sheet.addRow([
        text(row.standardNumber),
        text(row.clauseNumber),
        text(row.extractionType),
        text(row.label),
        text(row.placeholder),
        text(row.placeholderId),
        text(row.parentSelectionId),
        text(row.active),
        text(row.currentValue),
        text(row.rawCurrentValue),
        text(row.review),
        text(row.reviewReason),
      ]);
    }
  }
  const dataEnd = Math.max(2, sheet.rowCount);
  for (let rowNumber = 2; rowNumber <= dataEnd; rowNumber += 1) {
    sheet.getRow(rowNumber).alignment = { vertical: 'top', wrapText: true };
  }
  setColumns(sheet, [ 23, 14, 12, 34, 52, 34, 34, 15, 40, 42, 12, 42 ]);
  sheet.autoFilter = 'A1:L1';
  sheet.dataValidations.add(`C2:C${dataEnd}`, {
    type: 'list', allowBlank: true, formulae: [ '"赋值,选择"' ],
  });
  sheet.dataValidations.add(`H2:H${dataEnd}`, {
    type: 'list', allowBlank: true, formulae: [ '"是,否"' ],
  });
  sheet.dataValidations.add(`K2:K${dataEnd}`, {
    type: 'list', allowBlank: true, formulae: [ '"是,否"' ],
  });
  return sheet;
}

async function buildProjectAnswerWorkbook({ items = [], rows = [] } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '安全规范落实与持续监管系统';
  workbook.created = new Date();
  addInstructionSheet(workbook);
  const answerRows = rows.length
    ? rows
    : items.map(item => ({
      standardNumber: item.standard_number_snapshot,
      clauseNumber: item.item_code_snapshot,
    }));
  addSummarySheet(workbook, answerRows);
  addDetailSheet(workbook, rows);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = {
  DETAIL_HEADERS,
  SUMMARY_HEADERS,
  buildProjectAnswerWorkbook,
};
