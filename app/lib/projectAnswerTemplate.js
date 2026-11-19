'use strict';

const ExcelJS = require('exceljs');

const SUMMARY_HEADERS = [
  '条款号',
  '是否重点项',
  '应答赋值',
  '制度符合性描述',
  '实际证据',
  '适用性标记',
  '符合性标记',
  '备注',
  '标准化编号',
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
    [ '工作表', '说明' ],
    [ '标准工作表', '每个标准单独一个工作表，工作表名称就是可读的标准名称。' ],
    [ '条款号', '已按当前项目标准快照预填，用于定位条款，请勿修改。' ],
    [ '空白应答', '模板不导出项目中的现有应答；所有应答相关列均为空白。' ],
    [ '应答赋值', '直接填写人可阅读的最终应答，不需要填写占位符 ID、父子关系或内部映射。' ],
    [ '赋值示例', '单选题可填写“选择：选项名称”；赋值题可填写“提示名称：赋值内容”，多项时每行一项。' ],
    [ '适用性标记', '可填：未标记、适用、不适用。留空按“未标记”处理。' ],
    [ '符合性标记', '可填：未标记、符合、部分符合、不符合。留空按“未标记”处理。' ],
    [ '是否重点项', '可填：是、否。留空按“否”处理。' ],
    [ '空白行', '未填写任何应答字段的条款不会导入。' ],
    [ '标准化编号', '最后一个隐藏列由系统用于精确匹配，请勿删除或修改。' ],
  ];
  rows.forEach((values, index) => {
    const row = sheet.addRow(values);
    if (index === 0) styleHeader(row);
    else row.alignment = { vertical: 'top', wrapText: true };
  });
  setColumns(sheet, [ 22, 100 ]);
  sheet.autoFilter = 'A1:B1';
}

function standardKey(row) {
  return [
    text(row.standard_code),
    text(row.standard_name),
    text(row.standard_version),
  ].join('|');
}

function safeSheetBase(rows) {
  const sample = rows[0] || {};
  const readableName = text(sample.standard_name)
    || text(sample.standard_code)
    || '标准应答';
  return readableName.replace(/[\\/:*?\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31)
    || '标准应答';
}

function uniqueSheetName(base, usedNames, version = '') {
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }
  const suffix = version ? `（${text(version)}）` : `（${usedNames.size + 1}）`;
  const shortened = base.slice(0, Math.max(1, 31 - suffix.length));
  let candidate = `${shortened}${suffix}`.slice(0, 31);
  let index = 2;
  while (usedNames.has(candidate)) {
    const retrySuffix = `${index}`;
    candidate = `${base.slice(0, Math.max(1, 31 - retrySuffix.length))}${retrySuffix}`;
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function addStandardSheet(workbook, rows, sheetName) {
  const sheet = workbook.addWorksheet(sheetName, { views: [ { state: 'frozen', ySplit: 2 } ] });
  const sample = rows[0] || {};
  const standardTitle = [
    text(sample.standard_name) || text(sample.standard_code) || '标准应答',
    text(sample.standard_code),
    text(sample.standard_version),
  ].filter(Boolean).join(' · ');
  sheet.addRow([ standardTitle ]);
  sheet.mergeCells('A1:I1');
  sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF1F4D36' } };
  sheet.getCell('A1').alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 28;
  sheet.addRow(SUMMARY_HEADERS);
  styleHeader(sheet.getRow(2));

  for (const row of rows) {
    sheet.addRow([
      text(row.clauseNumber || row.item_code_snapshot),
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      text(row.standardNumber || row.standard_number_snapshot),
    ]);
  }
  const dataEnd = Math.max(3, sheet.rowCount);
  for (let rowNumber = 3; rowNumber <= dataEnd; rowNumber += 1) {
    sheet.getRow(rowNumber).alignment = { vertical: 'top', wrapText: true };
  }
  setColumns(sheet, [ 16, 12, 42, 58, 38, 13, 13, 32, 23 ]);
  sheet.autoFilter = 'A2:I2';
  sheet.getColumn(9).hidden = true;
  sheet.dataValidations.add(`B3:B${dataEnd}`, {
    type: 'list', allowBlank: true, formulae: [ '"是,否"' ],
  });
  sheet.dataValidations.add(`F3:F${dataEnd}`, {
    type: 'list', allowBlank: true, formulae: [ '"未标记,适用,不适用"' ],
  });
  sheet.dataValidations.add(`G3:G${dataEnd}`, {
    type: 'list', allowBlank: true, formulae: [ '"未标记,符合,部分符合,不符合"' ],
  });
  return sheet;
}

async function buildProjectAnswerWorkbook({ rows = [] } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '安全规范落实与持续监管系统';
  workbook.created = new Date();
  addInstructionSheet(workbook);
  const grouped = new Map();
  for (const row of rows) {
    const key = standardKey(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const usedNames = new Set([ '填写说明' ]);
  for (const standardRows of grouped.values()) {
    const base = safeSheetBase(standardRows);
    const sheetName = uniqueSheetName(base, usedNames, standardRows[0]?.standard_version);
    addStandardSheet(workbook, standardRows, sheetName);
  }
  if (!grouped.size) {
    const sheet = workbook.addWorksheet('标准应答');
    sheet.addRow([ '没有可生成模板的标准项' ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = {
  APPLICABILITY_LABELS,
  STATUS_LABELS,
  SUMMARY_HEADERS,
  buildProjectAnswerWorkbook,
};
