'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_SHEETS = 100;
const MAX_ROWS_PER_SHEET = 20000;
const MAX_ITEMS = 20000;
const DEFAULT_CLOUD_CENTERS = [ '统一运维中心', '抚州', '新疆' ];

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('');
    if (Object.prototype.hasOwnProperty.call(value, 'text')) return String(value.text || '');
    if (Object.prototype.hasOwnProperty.call(value, 'result')) return cellText(value.result);
  }
  return String(value);
}

function normalizeHeader(value) {
  return cellText(value).normalize('NFKC').toLowerCase()
    .replace(/[\s\u3000]/g, '').replace(/[：:]/g, '');
}

function normalizeKey(value) {
  return cellText(value).normalize('NFKC').toLowerCase()
    .replace(/[\s\u3000]/g, '').replace(/[（）()【】\[\]、，,。；;：:]/g, '')
    .trim();
}

function importError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function findColumn(rows, aliases, start = 0) {
  const width = Math.max(rows[0]?.length || 0, rows[1]?.length || 0);
  for (const alias of aliases) {
    const wanted = normalizeHeader(alias);
    for (let index = start; index < width; index += 1) {
      const first = normalizeHeader(rows[0]?.[index]);
      const second = normalizeHeader(rows[1]?.[index]);
      if (first === wanted || second === wanted || first.includes(wanted) || second.includes(wanted)) return index;
    }
  }
  return -1;
}

function findHeader(rows) {
  const first = rows[0] || [];
  const second = rows[1] || [];
  const map = {
    externalItemNo: findColumn(rows, [ '标准项编号' ]),
    chapterCode: findColumn(rows, [ '章节号', '章节编号' ]),
    chapterName: findColumn(rows, [ '章节名称' ]),
    standardCode: findColumn(rows, [ '标准号' ]),
    standardName: findColumn(rows, [ '标准名称' ]),
    levelNumber: findColumn(rows, [ '级别号' ]),
    level: findColumn(rows, [ '级别' ]),
    clauseNumber: findColumn(rows, [ '条款号', '对应标准号', '标准编号' ]),
    content: findColumn(rows, [ '标准内容', '标准项内容', '标准要求' ]),
    isKey: findColumn(rows, [ '是否为重点项' ]),
    providerAssignment: findColumn(rows, [ '云服务商赋值' ]),
    unifiedRequirement: findColumn(rows, [ '多云统管制度规范体系具体要求', '多云统管体系具体要求', '统一规范要求' ]),
    expectedEvidence: findColumn(rows, [ '统一规范实施证据列表' ]),
    pendingEvidence: findColumn(rows, [ '待提供证据' ]),
    problem: findColumn(rows, [ '问题列' ]),
    responsible: findColumn(rows, [ '负责人' ]),
  };
  if (map.clauseNumber < 0 || map.content < 0) return null;
  const dataStart = first.some(value => normalizeHeader(value) === '标准项编号') || second.some(value => normalizeHeader(value) === '标准项编号') ? 2 : 1;
  return { map, dataStart };
}

function parseStatus(value) {
  const text = cellText(value).trim();
  if (!text) return null;
  if (/不适用|不涉及|不适?.*用/.test(text)) return { status: 'unassessed', applicability: 'not_applicable' };
  if (/部分|基本满足|有条件满足/.test(text)) return { status: 'partially_satisfied', applicability: 'applicable' };
  if (/不满足|不符合|不合格/.test(text)) return { status: 'not_satisfied', applicability: 'applicable' };
  if (/满足|符合|合格/.test(text)) return { status: 'satisfied', applicability: 'applicable' };
  return { status: 'unassessed', applicability: 'unspecified' };
}

function isEmptyEvidence(value) {
  const text = cellText(value).trim();
  return !text || /^(默认\s*[:：]?\s*)?无$/i.test(text) || text.length <= 3 && /^无[。.]?$/.test(text);
}

function splitEvidence(value) {
  if (isEmptyEvidence(value)) return [];
  return cellText(value).split(/\r?\n|；|;/).map(item => item.trim()).filter(item => !isEmptyEvidence(item));
}

function extractLine(text, labels) {
  const source = cellText(text);
  for (const label of labels) {
    const match = source.match(new RegExp(`${label}\\s*[:：]\\s*([^\\n]+)`, 'i'));
    if (match) return match[1].trim();
  }
  return '';
}

function detectCloudGroups(rows, map) {
  const second = rows[1] || [];
  const starts = [];
  for (let index = Math.max(0, map.content + 1); index < second.length; index += 1) {
    if (normalizeHeader(second[index]).includes('满足情况')) starts.push(index);
  }
  return starts.map((start, index) => ({
    name: DEFAULT_CLOUD_CENTERS[index] || `云中心列组${index + 1}`,
    slot: index,
    status: start,
    measure: start + 1,
    evidence: start + 2,
  }));
}

function detectSupervisionGroups(rows, map) {
  const second = rows[1] || [];
  const starts = [];
  for (let index = Math.max(0, map.content + 1); index < second.length; index += 1) {
    const header = normalizeHeader(second[index]);
    if (header.includes('监督检查措施') || header.includes('监督检查机制')) starts.push(index);
  }
  return starts.map((start, index) => {
    const end = starts[index + 1] || second.length;
    const contentColumns = [];
    const resultColumns = [];
    for (let column = start + 1; column < end; column += 1) {
      const header = cellText(second[column]);
      if (/检查内容/.test(header)) contentColumns.push({ column, label: header });
      if (/检查结果/.test(header)) resultColumns.push({ column, label: header });
    }
    return { measure: start, slot: index, contentColumns, resultColumns };
  });
}

function parseProjectRows(sheets) {
  const rows = [];
  let importedSheetCount = 0;
  let skippedSheetCount = 0;
  const cloudCenterNames = new Set();
  for (const sheet of sheets) {
    const header = findHeader(sheet.rows || []);
    if (!header) {
      skippedSheetCount += 1;
      continue;
    }
    importedSheetCount += 1;
    const map = header.map;
    const cloudGroups = detectCloudGroups(sheet.rows, map);
    for (const group of cloudGroups) cloudCenterNames.add(group.name);
    const supervisionGroups = detectSupervisionGroups(sheet.rows, map);
    const carry = {};
    for (let rowIndex = header.dataStart; rowIndex < sheet.rows.length; rowIndex += 1) {
      const source = sheet.rows[rowIndex] || [];
      const value = column => column >= 0 ? cellText(source[column]).trim() : '';
      const clauseNumber = value(map.clauseNumber);
      const content = value(map.content);
      if (!clauseNumber && !content) continue;
      if (!clauseNumber) throw importError(`工作表“${sheet.name}”第${rowIndex + 1}行缺少条款号`);
      if (!content) throw importError(`工作表“${sheet.name}”第${rowIndex + 1}行缺少标准内容`);
      for (const field of [ 'chapterCode', 'chapterName', 'standardCode', 'standardName', 'levelNumber', 'level' ]) {
        const current = value(map[field]);
        if (current) carry[field] = current;
      }
      const cloudCenters = {};
      for (const group of cloudGroups) {
        const status = value(group.status);
        const measure = value(group.measure);
        const evidence = value(group.evidence);
        if (status || measure || evidence) {
          cloudCenters[group.name] = { status: parseStatus(status), measure, evidence, evidenceItems: splitEvidence(evidence) };
          cloudCenterNames.add(group.name);
        }
      }
      const supervision = [];
      for (const group of supervisionGroups) {
        const measure = value(group.measure);
        if (!measure) continue;
        const observations = [];
        for (const [ contentIndex, column ] of group.contentColumns.entries()) {
          const checkedContent = value(column.column);
          if (!checkedContent) continue;
          const centerName = column.label.split(/[-：:]/).slice(1).join('-').trim();
          const resultColumn = group.resultColumns.find(item => item.column > column.column);
          const slot = group.contentColumns.length > 1 ? contentIndex : group.slot;
          observations.push({ centerName, slot, content: checkedContent, result: resultColumn ? value(resultColumn.column) : '' });
        }
        supervision.push({ measure, slot: group.slot, frequency: extractLine(measure, [ '检查频率', '频率' ]), method: extractLine(measure, [ '检查方法', '检查方式' ]), observations });
      }
      const isKeyText = value(map.isKey);
      rows.push({
        sourceSheet: sheet.name,
        sourceRow: rowIndex + 1,
        externalItemNo: value(map.externalItemNo),
        chapterCode: carry.chapterCode || '',
        chapterName: carry.chapterName || sheet.name,
        standardCode: carry.standardCode || '',
        standardName: carry.standardName || '',
        levelNumber: carry.levelNumber || '',
        level: carry.level || '',
        clauseNumber,
        content,
        isKey: isKeyText ? /是|重点|重要|yes|true/i.test(isKeyText) : null,
        providerAssignment: value(map.providerAssignment),
        unifiedRequirement: value(map.unifiedRequirement),
        expectedEvidence: value(map.expectedEvidence),
        pendingEvidence: value(map.pendingEvidence),
        problem: value(map.problem),
        responsible: value(map.responsible),
        cloudCenters,
        supervision,
      });
      if (rows.length > MAX_ITEMS) throw importError(`一次最多导入${MAX_ITEMS}个标准项`);
    }
  }
  if (!rows.length) throw importError('未找到可导入的项目标准项；请确认文件包含“条款号”和“标准内容”列');
  const rowByCode = new Map();
  for (const row of rows) {
    const key = normalizeKey(row.clauseNumber);
    if (rowByCode.has(key)) {
      const previous = rowByCode.get(key);
      throw importError(`条款号“${row.clauseNumber}”重复（工作表“${previous.sourceSheet}”第${previous.sourceRow}行、工作表“${row.sourceSheet}”第${row.sourceRow}行）`);
    }
    rowByCode.set(key, row);
  }
  return { rows, importedSheetCount, skippedSheetCount, cloudCenterNames: [ ...cloudCenterNames ] };
}

async function parseProjectWorkbookFile(filePath, fileName) {
  const extension = path.extname(fileName || filePath).toLowerCase();
  if (extension !== '.xlsx') throw importError('项目数据导入仅支持 .xlsx 文件');
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_SIZE) throw importError('项目数据文件不能超过50MB');
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath, { ignoreNodes: [ 'dataValidations' ] });
  } catch (error) {
    const wrapped = importError('Excel文件无法读取，请确认文件为有效的.xlsx工作簿');
    wrapped.cause = error;
    throw wrapped;
  }
  if (workbook.worksheets.length > MAX_SHEETS) throw importError(`工作簿最多支持${MAX_SHEETS}个工作表`);
  const sheets = workbook.worksheets.map(worksheet => {
    if (worksheet.rowCount > MAX_ROWS_PER_SHEET || worksheet.columnCount > 512) throw importError(`工作表“${worksheet.name}”行数或列数超出导入限制`);
    const rows = [];
    worksheet.eachRow({ includeEmpty: true }, row => { rows[row.number - 1] = (row.values || []).slice(1).map(cellText); });
    return { name: worksheet.name, rows };
  });
  return parseProjectRows(sheets);
}

module.exports = {
  DEFAULT_CLOUD_CENTERS,
  parseProjectRows,
  parseProjectWorkbookFile,
  parseStatus,
  normalizeKey,
  splitEvidence,
};
