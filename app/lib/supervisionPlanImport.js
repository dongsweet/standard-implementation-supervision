'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const { joinSupervisionMethods } = require('./supervisionMethods');
const { DEFAULT_SUPERVISION_CENTERS, splitSupervisionCenters } = require('./supervisionCenters');

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const MAX_ROWS = 12000;

const PLAN_HEADERS = [
  '标准化编号',
  '是否公认对象',
  '检查范围',
  '适用检查中心',
  '对象分类',
  '检查对象',
  '检查层面',
  '检查方法',
  '检查项描述',
  '检查步骤',
  '检查频率',
  '重点项',
  '执行方式',
  '参考判定描述',
  '参考材料',
];

const PLAN_WIDTHS = [ 32, 16, 18, 24, 32, 18, 24, 30, 64, 72, 16, 14, 16, 64, 56 ];

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('').trim();
    if (Object.prototype.hasOwnProperty.call(value, 'text')) return String(value.text || '').trim();
    if (Object.prototype.hasOwnProperty.call(value, 'result')) return cellText(value.result);
  }
  return String(value).trim();
}

function normalizeHeader(value) {
  return cellText(value).normalize('NFKC').toLowerCase()
    .replace(/[\s\u3000]/g, '').replace(/[（）()【】\[\]、，,。；;：:]/g, '');
}

function importError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function readExcelWorkbook(filePath, ExcelJS) {
  let workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath, { ignoreNodes: [ 'dataValidations' ] });
    return workbook;
  } catch (error) {
    // Some Excel-compatible exporters prefix every main OOXML element with
    // `x:`. ExcelJS expects the same namespace without that prefix.
    try {
      const bytes = await fs.readFile(filePath);
      const archive = await JSZip.loadAsync(bytes);
      let normalized = false;
      for (const name of Object.keys(archive.files).filter(item => item.endsWith('.xml'))) {
        const entry = archive.file(name);
        if (!entry) continue;
        const xml = await entry.async('string');
        if (!/<\/?x:[A-Za-z_]/.test(xml)) continue;
        const hasDefaultNamespace = /\sxmlns\s*=/.test(xml);
        let updated = xml.replace(/(<\/?)(x:)/g, '$1');
        updated = hasDefaultNamespace
          ? updated.replace(/\sxmlns:x=(['"][^'"]+['"])/g, '')
          : updated.replace(/xmlns:x=/g, 'xmlns=');
        archive.file(name, updated);
        normalized = true;
      }
      if (!normalized) throw error;
      workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(
        await archive.generateAsync({ type: 'nodebuffer' }),
        { ignoreNodes: [ 'dataValidations' ] }
      );
      return workbook;
    } catch (fallbackError) {
      const wrapped = importError('Excel文件无法读取，请确认文件为有效的.xlsx工作簿');
      wrapped.cause = error;
      wrapped.fallbackCause = fallbackError;
      throw wrapped;
    }
  }
}

function splitStandardNumbers(value) {
  const unique = cellText(value).normalize('NFKC')
    .split(/[\r\n,，;；、/|]+/)
    .map(item => item.trim())
    .filter(Boolean);
  const distinct = [ ...new Set(unique) ];
  const ignoredX = distinct.filter(item => /^X/i.test(item));
  const values = distinct.filter(item => !/^X/i.test(item));
  const invalid = values.filter(item => !/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/i.test(item));
  return { values, invalid, ignoredX };
}

function optionalBoolean(value, label, sourceRow, errors) {
  const text = cellText(value).normalize('NFKC').trim();
  if (!text) return null;
  if (/^(是|true|yes|1)$/i.test(text)) return true;
  if (/^(否|false|no|0)$/i.test(text)) return false;
  errors.push(`第${sourceRow}行“${label}”只能填写“是”或“否”`);
  return null;
}

function findHeader(rows) {
  const aliases = {
    standardNumbers: [ '标准化编号', '标准编号' ],
    recognizedObject: [ '是否公认对象' ],
    scope: [ '检查范围', '检查项位于' ],
    centers: [ '适用检查中心', '检查中心' ],
    objectCategory: [ '对象分类' ],
    objectName: [ '检查对象' ],
    checkLayer: [ '检查层面' ],
    checkMethod: [ '检查方法' ],
    description: [ '检查项描述', '检查描述' ],
    steps: [ '检查步骤' ],
    frequency: [ '检查频率', '频率' ],
    priority: [ '重点项' ],
    accessMode: [ '执行方式', '远程现场方式' ],
    referenceResult: [ '参考判定描述', '检查结果参考描述' ],
    referenceMaterials: [ '参考材料', '证明材料' ],
  };
  for (let rowIndex = 0; rowIndex < Math.min(20, rows.length); rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const map = {};
    for (const [ field, names ] of Object.entries(aliases)) {
      const normalized = new Set(names.map(normalizeHeader));
      map[field] = row.findIndex(value => normalized.has(normalizeHeader(value)));
    }
    if (map.standardNumbers >= 0 && map.objectName >= 0 && map.checkMethod >= 0 && map.description >= 0) {
      return { rowIndex, map };
    }
  }
  return null;
}

function readCell(row, columnIndex) {
  return columnIndex >= 0 ? cellText(row[columnIndex]) : '';
}

function parseSupervisionPlanRows(sheets) {
  const rows = [];
  const errors = [];
  let importedSheetCount = 0;
  let skippedSheetCount = 0;
  let ignoredXRowCount = 0;
  let ignoredXNumberCount = 0;
  for (const sheet of sheets || []) {
    const sourceRows = sheet.rows || [];
    const header = findHeader(sourceRows);
    if (!header) {
      skippedSheetCount += 1;
      continue;
    }
    importedSheetCount += 1;
    for (let rowIndex = header.rowIndex + 1; rowIndex < sourceRows.length; rowIndex += 1) {
      const source = sourceRows[rowIndex] || [];
      if (!source.some(value => cellText(value))) continue;
      const sourceRow = rowIndex + 1;
      const { values: standardNumbers, invalid, ignoredX } = splitStandardNumbers(readCell(source, header.map.standardNumbers));
      ignoredXNumberCount += ignoredX.length;
      if (!standardNumbers.length && !invalid.length && ignoredX.length) {
        ignoredXRowCount += 1;
        continue;
      }
      if (!standardNumbers.length) errors.push(`工作表“${sheet.name}”第${sourceRow}行缺少标准化编号`);
      if (invalid.length) errors.push(`工作表“${sheet.name}”第${sourceRow}行包含无效标准编号：${invalid.join('、')}`);
      const objectName = readCell(source, header.map.objectName);
      const checkMethod = joinSupervisionMethods(readCell(source, header.map.checkMethod));
      const description = readCell(source, header.map.description);
      if (!objectName) errors.push(`工作表“${sheet.name}”第${sourceRow}行缺少检查对象`);
      if (!checkMethod) errors.push(`工作表“${sheet.name}”第${sourceRow}行缺少检查方法`);
      if (!description) errors.push(`工作表“${sheet.name}”第${sourceRow}行缺少检查项描述`);
      const lengthLimits = [
        [ '检查对象', objectName, 500 ],
        [ '检查范围', readCell(source, header.map.scope), 200 ],
        [ '适用检查中心', readCell(source, header.map.centers), 200 ],
        [ '对象分类', readCell(source, header.map.objectCategory), 200 ],
        [ '检查层面', readCell(source, header.map.checkLayer), 200 ],
        [ '检查方法', checkMethod, 2000 ],
        [ '检查项描述', description, 5000 ],
        [ '检查频率', readCell(source, header.map.frequency), 100 ],
        [ '重点项', readCell(source, header.map.priority), 50 ],
        [ '执行方式', readCell(source, header.map.accessMode), 50 ],
      ];
      for (const [ label, value, maxLength ] of lengthLimits) {
        if ([ ...value ].length > maxLength) {
          errors.push(`工作表“${sheet.name}”第${sourceRow}行“${label}”超过${maxLength}字限制`);
        }
      }
      const recognizedErrors = [];
      const recognizedObject = optionalBoolean(readCell(source, header.map.recognizedObject), '是否公认对象', sourceRow, recognizedErrors);
      errors.push(...recognizedErrors.map(message => `工作表“${sheet.name}”${message}`));
      const priority = readCell(source, header.map.priority);
      if (priority && ![ '重点项', '非重点项', '重点', '非重点' ].includes(priority)) {
        errors.push(`工作表“${sheet.name}”第${sourceRow}行“重点项”只能填写“重点项”或“非重点项”`);
      }
      const rawScope = readCell(source, header.map.scope);
      let centers = splitSupervisionCenters(readCell(source, header.map.centers));
      let scope = rawScope;
      if (!centers.length) {
        const legacyCenters = splitSupervisionCenters(rawScope);
        if (legacyCenters.length && legacyCenters.every(center => DEFAULT_SUPERVISION_CENTERS.includes(center))) {
          centers = legacyCenters;
          scope = '';
        }
      }
      if (!centers.length && header.map.centers >= 0) errors.push(`工作表“${sheet.name}”第${sourceRow}行缺少适用检查中心`);
      const unknownCenters = centers.filter(center => !DEFAULT_SUPERVISION_CENTERS.includes(center));
      if (unknownCenters.length) errors.push(`工作表“${sheet.name}”第${sourceRow}行包含未知检查中心：${unknownCenters.join('、')}`);
      rows.push({
        sourceSheet: sheet.name,
        sourceRow,
        standardNumbers,
        recognizedObject,
        scope,
        centers,
        objectCategory: readCell(source, header.map.objectCategory),
        objectName,
        checkLayer: readCell(source, header.map.checkLayer),
        checkMethod,
        description,
        steps: readCell(source, header.map.steps),
        frequency: readCell(source, header.map.frequency),
        priority: priority === '重点' ? '重点项' : priority === '非重点' ? '非重点项' : priority,
        accessMode: readCell(source, header.map.accessMode),
        referenceResult: readCell(source, header.map.referenceResult),
        referenceMaterials: readCell(source, header.map.referenceMaterials),
      });
      if (rows.length > MAX_ROWS) throw importError(`一次最多导入${MAX_ROWS}条检查方案`);
    }
  }
  if (!importedSheetCount || !rows.length) throw importError('未找到可导入的检查方案数据；X编号行会被忽略，请使用检查方案导入模板');
  if (errors.length) {
    const error = importError(`检查方案模板有${errors.length}处错误：${errors.slice(0, 20).join('；')}`);
    error.details = errors;
    throw error;
  }
  return { rows, importedSheetCount, skippedSheetCount, ignoredXRowCount, ignoredXNumberCount };
}

async function parseSupervisionPlanFile(filePath, fileName = '') {
  if (path.extname(fileName || filePath).toLowerCase() !== '.xlsx') throw importError('检查方案导入仅支持.xlsx文件');
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_SIZE) throw importError('导入文件不能超过15MB');
  let ExcelJS;
  try {
    ExcelJS = require('exceljs');
  } catch {
    throw importError('服务器Excel组件不可用，暂时无法读取工作簿');
  }
  const workbook = await readExcelWorkbook(filePath, ExcelJS);
  const sheets = workbook.worksheets.map(worksheet => {
    if (worksheet.rowCount > MAX_ROWS + 20 || worksheet.columnCount > 128) {
      throw importError(`工作表“${worksheet.name}”行数或列数超出导入限制`);
    }
    const rows = [];
    worksheet.eachRow({ includeEmpty: true }, excelRow => {
      rows[excelRow.number - 1] = (excelRow.values || []).slice(1).map(cellText);
    });
    return { name: worksheet.name, rows };
  });
  return parseSupervisionPlanRows(sheets);
}

function styleHeader(row) {
  row.height = 30;
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF28744A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFB7D8C5' } } };
  });
}

function addInstructions(workbook) {
  const sheet = workbook.addWorksheet('填写说明', { views: [ { state: 'frozen', ySplit: 2 } ] });
  sheet.addRow([ '检查方案导入模板填写说明' ]);
  sheet.mergeCells('A1:B1');
  sheet.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FF1F4D36' } };
  sheet.getRow(1).height = 30;
  const rows = [
    [ '字段', '填写规则' ],
    [ '标准化编号', '填写系统标准化编号；一条检查方案关联多个标准项时，在同一格内每行填写一个编号。' ],
    [ '适用检查中心', '可多选：云中心、统一运维中心、总部；多个中心用顿号或逗号分隔。中心不同但对象、检查内容和方法相同的项目可以合并为一行。' ],
    [ '检查范围', '描述检查内容适用的范围或位置；检查中心请填写在“适用检查中心”列。' ],
    [ 'X编号', '以X开头的编号会忽略；一格内混有X编号和有效系统标准化编号时，仅保留有效编号。' ],
    [ '检查方法', '可填写一种或多种；多项用逗号分隔，例如“证据材料核查,上机查看”。' ],
    [ '是否公认对象', '可填“是”或“否”；留空表示未指定。' ],
    [ '重点项', '可填“重点项”或“非重点项”；留空表示未指定。' ],
    [ '执行方式', '填写远程、现场或远程+现场。' ],
    [ '参考判定描述', '填写方案采用的判定参考，不填写某次检查的实际结论或执行结果。' ],
    [ '参考材料', '填写可用于方案设计的参考材料名称，不填写本次执行产生的证据。' ],
    [ '不导入字段', '不填写旧内部编号、安评中心抽查序号、检查人、检查时间、实际检查结果、整改结果或执行证据。' ],
    [ '必填项', '标准化编号、检查对象、检查方法、检查项描述为必填。' ],
    [ '空白行', '没有填写任何内容的行会被忽略。其他未完成的行会报错，不会静默跳过。' ],
  ];
  rows.forEach((values, index) => {
    const row = sheet.addRow(values);
    if (index === 0) styleHeader(row);
    else row.alignment = { vertical: 'top', wrapText: true };
  });
  sheet.getColumn(1).width = 24;
  sheet.getColumn(2).width = 100;
  sheet.autoFilter = 'A2:B2';
}

async function buildSupervisionPlanTemplate() {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '安全规范落实与持续监管系统';
  addInstructions(workbook);
  const sheet = workbook.addWorksheet('检查方案', { views: [ { state: 'frozen', ySplit: 1 } ] });
  sheet.addRow(PLAN_HEADERS);
  styleHeader(sheet.getRow(1));
  PLAN_WIDTHS.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.autoFilter = `A1:${String.fromCharCode(64 + PLAN_HEADERS.length)}1`;
  sheet.dataValidations.add('B2:B5000', { type: 'list', allowBlank: true, formulae: [ '"是,否"' ] });
  sheet.dataValidations.add('G2:G5000', { type: 'list', allowBlank: true, formulae: [ '"云中心,统一运维中心,总部"' ] });
  sheet.dataValidations.add('K2:K5000', { type: 'list', allowBlank: true, formulae: [ '"重点项,非重点项"' ] });
  sheet.dataValidations.add('L2:L5000', { type: 'list', allowBlank: true, formulae: [ '"远程,现场,远程+现场"' ] });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = {
  PLAN_HEADERS,
  buildSupervisionPlanTemplate,
  parseSupervisionPlanFile,
  parseSupervisionPlanRows,
  splitStandardNumbers,
};
