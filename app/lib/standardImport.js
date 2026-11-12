'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const MAX_SHEETS = 100;
const MAX_ROWS_PER_SHEET = 20000;
const MAX_ITEMS = 12000;
const FIELD_ALIASES = {
  chapterCode: [ '章节编号' ],
  chapterName: [ '章节名称' ],
  sectionName: [ '标准名称', '标准子类' ],
  itemCode: [ '标准项编号', '标准编号', '对应标准号' ],
  itemTitle: [ '标准项标题' ],
  content: [ '标准内容', '标准项内容', '标准要求' ],
};
const SECOND_HEADER_MARKERS = new Set([
  '多云统管体系具体要求', '统一规范实施证据列表', '满足情况',
  '安全措施运行情况描述', '举证',
]);

function importError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

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
    .replaceAll(' ', '').replaceAll('\t', '').replaceAll('\r', '').replaceAll('\n', '');
}

function headerMap(primaryRow, secondaryRow = []) {
  const width = Math.max(primaryRow.length, secondaryRow.length);
  const result = {};
  for (const [ field, aliases ] of Object.entries(FIELD_ALIASES)) {
    const normalizedAliases = new Set(aliases.map(normalizeHeader));
    result[field] = Array.from({ length: width }, (_, index) => index).findIndex(index =>
      normalizedAliases.has(normalizeHeader(primaryRow[index]))
      || normalizedAliases.has(normalizeHeader(secondaryRow[index]))
    );
  }
  return result;
}

function findHeader(rows) {
  const searchEnd = Math.min(rows.length, 20);
  for (let index = 0; index < searchEnd; index += 1) {
    const primary = rows[index] || [];
    const firstMap = headerMap(primary);
    const next = rows[index + 1] || [];
    const hasSecondHeader = next.some(value => SECOND_HEADER_MARKERS.has(normalizeHeader(value)));
    const combinedMap = headerMap(primary, next);
    const requiredFieldsInSecondRow = (firstMap.itemCode < 0 || firstMap.content < 0)
      && combinedMap.itemCode >= 0 && combinedMap.content >= 0
      && combinedMap.itemCode !== combinedMap.content;
    const usesSecondHeader = hasSecondHeader || requiredFieldsInSecondRow;
    const map = usesSecondHeader ? combinedMap : firstMap;
    if (map.itemCode < 0 || map.content < 0 || map.itemCode === map.content) continue;
    return { map, dataStart: index + (usesSecondHeader ? 2 : 1) };
  }
  return null;
}

function splitChapter(value) {
  const text = cellText(value);
  let index = 0;
  let hasDot = false;
  let expectDigit = true;
  while (index < text.length) {
    const char = text[index];
    if (char >= '0' && char <= '9') {
      expectDigit = false;
      index += 1;
    } else if (char === '.' && !expectDigit) {
      hasDot = true;
      expectDigit = true;
      index += 1;
    } else {
      break;
    }
  }
  const prefix = text.slice(0, index);
  const following = text.slice(index);
  if (hasDot && prefix && !expectDigit) {
    return { code: prefix, name: following.trim() || text };
  }
  return { code: text, name: text };
}

function parseStandardRows(sheets, options = {}) {
  const { allowDuplicateItemCodes = false } = options;
  const chapters = [];
  const chaptersByCode = new Map();
  const itemCodes = new Set();
  let importedSheetCount = 0;
  let skippedSheetCount = 0;
  let itemCount = 0;
  let duplicateItemCount = 0;

  for (const sheet of sheets) {
    const rows = sheet.rows || [];
    const header = findHeader(rows);
    if (!header) {
      skippedSheetCount += 1;
      continue;
    }
    importedSheetCount += 1;
    let currentGroupName = '';
    let currentSectionName = '';
    for (let rowIndex = header.dataStart; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] || [];
      const value = field => header.map[field] >= 0 ? cellText(row[header.map[field]]) : '';
      const itemCode = value('itemCode');
      const content = value('content');
      if (!itemCode && !content) continue;
      const sourceRow = rowIndex + 1;
      if (!itemCode) throw importError('工作表“' + sheet.name + '”第' + sourceRow + '行缺少标准项编号');
      if (!content) throw importError('工作表“' + sheet.name + '”第' + sourceRow + '行缺少标准内容');
      const normalizedItemCode = itemCode.normalize('NFKC').toUpperCase();
      if (itemCodes.has(normalizedItemCode)) {
        if (!allowDuplicateItemCodes) throw importError('工作簿中标准项编号重复：' + itemCode);
        duplicateItemCount += 1;
        continue;
      }
      itemCodes.add(normalizedItemCode);
      if (itemCode.length > 100) throw importError('工作表“' + sheet.name + '”第' + sourceRow + '行的标准项编号不能超过100个字符');
      if (value('itemTitle').length > 500) throw importError('工作表“' + sheet.name + '”第' + sourceRow + '行的标准项标题不能超过500个字符');
      itemCount += 1;
      if (itemCount > MAX_ITEMS) throw importError('一次最多导入' + MAX_ITEMS + '个标准项');

      const groupName = value('chapterName');
      if (groupName) currentGroupName = groupName;
      const sectionName = value('sectionName');
      if (sectionName) currentSectionName = sectionName;
      const explicitCode = value('chapterCode');
      const explicitName = value('chapterName');
      const sourceName = explicitName || currentSectionName || currentGroupName || sheet.name;
      const derived = splitChapter(sourceName);
      const chapterCode = explicitCode || derived.code;
      const chapterName = explicitName ? splitChapter(explicitName).name : derived.name;
      if (!chapterCode || !chapterName) throw importError('工作表“' + sheet.name + '”第' + sourceRow + '行无法识别所属章节');
      if (chapterCode.length > 100 || chapterName.length > 300) {
        throw importError('工作表“' + sheet.name + '”第' + sourceRow + '行的章节编号或名称超出长度限制');
      }

      const chapterKey = chapterCode.normalize('NFKC').toLowerCase();
      let chapter = chaptersByCode.get(chapterKey);
      if (!chapter) {
        chapter = { code: chapterCode, name: chapterName, sortOrder: chapters.length * 10, items: [] };
        chaptersByCode.set(chapterKey, chapter);
        chapters.push(chapter);
      } else if (chapter.name !== chapterName) {
        throw importError('章节编号“' + chapterCode + '”对应了多个不同章节名称');
      }

      chapter.items.push({
        itemCode,
        title: value('itemTitle') || null,
        content,
      });
    }
  }
  if (!itemCount) throw importError('未找到可导入的标准项；请确认文件包含“标准项编号”和“标准内容”列');
  return { chapters, itemCount, importedSheetCount, skippedSheetCount, duplicateItemCount };
}

function parseDelimitedRows(text, delimiter) {
  const source = String(text || '').charCodeAt(0) === 0xFEFF ? String(text).slice(1) : String(text || '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const quote = String.fromCharCode(34);
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === quote) {
      if (quoted && source[index + 1] === quote) {
        field += quote;
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some(value => String(value).trim())) rows.push(row);
      row = [];
      field = '';
    } else if ((char === '\n' || char === '\r') && quoted) {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      field += '\n';
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some(value => String(value).trim())) rows.push(row);
  return rows;
}

async function parseStandardImportFile(filePath, fileName, options = {}) {
  const extension = path.extname(fileName || filePath).toLowerCase();
  if (![ '.xlsx', '.tsv' ].includes(extension)) throw importError('仅支持 .xlsx 或 .tsv 文件');
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_SIZE) throw importError('导入文件不能超过15MB');
  if (extension === '.tsv') {
    const text = await fs.readFile(filePath, 'utf8');
    return parseStandardRows([ { name: path.basename(fileName || filePath), rows: parseDelimitedRows(text, '\t') } ], options);
  }

  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  try {
    // Data validation rules are workbook UI metadata. Some operational
    // workbooks apply them to entire Excel columns (up to row 1,048,576),
    // which makes ExcelJS expand millions of addresses while parsing.
    // The importer only needs cell values, so skip that metadata node.
    await workbook.xlsx.readFile(filePath, { ignoreNodes: [ 'dataValidations' ] });
  } catch (error) {
    const wrapped = importError('Excel文件无法读取，请确认文件为有效的.xlsx工作簿');
    wrapped.cause = error;
    throw wrapped;
  }
  if (workbook.worksheets.length > MAX_SHEETS) throw importError('工作簿最多支持' + MAX_SHEETS + '个工作表');
  const sheets = workbook.worksheets.map(worksheet => {
    if (worksheet.rowCount > MAX_ROWS_PER_SHEET || worksheet.columnCount > 512) {
      throw importError('工作表“' + worksheet.name + '”行数或列数超出导入限制');
    }
    const rows = [];
    worksheet.eachRow({ includeEmpty: true }, excelRow => {
      rows[excelRow.number - 1] = (excelRow.values || []).slice(1).map(cellText);
    });
    return { name: worksheet.name, rows };
  });
  return parseStandardRows(sheets, options);
}

module.exports = { parseDelimitedRows, parseStandardImportFile, parseStandardRows };
