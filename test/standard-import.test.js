'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const StandardCatalogRepository = require('../app/repository/standardCatalog');
const { parseDelimitedRows, parseStandardImportFile, parseStandardRows } = require('../app/lib/standardImport');

const tab = String.fromCharCode(9);
const newline = String.fromCharCode(10);

test('maps two-row headers and carries merged chapter names forward', () => {
  const result = parseStandardRows([ { name: '源工作表', rows: [
    [ '标准名称', '标准项编号', '标准项标题', '标准内容', '级别', '是否为重点项', '条款占位符赋值', '适用云服务商', '统管分组', '统管分组', '应答', '监督' ],
    [ '', '', '', '', '', '', '', '', '多云统管体系具体要求', '统一规范实施证据列表', '满足情况', '检查频率' ],
    [ '8.1 用户标识与鉴别', '8.1.1', '账号管理', '应建立账号管理要求', '三级', '是', '火灾', '华为云、阿里云', '统一账号策略', '制度、配置截图', '满足', '每年' ],
    [ '', '8.1.2', '身份鉴别', '应采用身份鉴别措施', '三级', '否', '电磁泄漏', '腾讯云', '', '', '部分满足', '每季度' ],
  ] } ]);
  assert.equal(result.itemCount, 2);
  assert.deepEqual([ result.chapters[0].code, result.chapters[0].name ], [ '8.1', '用户标识与鉴别' ]);
  assert.deepEqual(result.chapters[0].items[0], {
    itemCode: '8.1.1',
    title: '账号管理',
    content: '应建立账号管理要求',
  });
  assert.equal(Object.hasOwn(result.chapters[0].items[0], 'unifiedRequirement'), false);
  assert.equal(Object.hasOwn(result.chapters[0].items[0], 'expectedEvidence'), false);
  assert.equal(Object.hasOwn(result.chapters[0].items[0], 'providerNames'), false);
  assert.equal(Object.hasOwn(result.chapters[0].items[0], 'satisfaction'), false);
  assert.equal(Object.hasOwn(result.chapters[0].items[0], 'frequency'), false);
});

test('recognizes required field names placed only in the second header row', () => {
  const result = parseStandardRows([ { name: '双层表头', rows: [
    [ '章节信息', '章节信息', '标准条款', '标准条款' ],
    [ '章节编号', '章节名称', '标准项编号', '标准内容' ],
    [ '4', '访问控制', '4.1', '应建立访问控制策略' ],
  ] } ]);
  assert.equal(result.itemCount, 1);
  assert.deepEqual([ result.chapters[0].code, result.chapters[0].name ], [ '4', '访问控制' ]);
});

test('ignores instruction sheets whose adjacent labels share one column', () => {
  const sheets = [
    { name: '标准原文', rows: [
      [ '章节编号', '章节名称', '标准项编号', '标准内容' ],
      [ '8.1', '用户标识与鉴别', '8.1.1', '应建立账号管理要求' ],
    ] },
    { name: '填写说明', rows: [
      [ '填写说明' ],
      [ '章节编号', '例如 8.1' ],
      [ '章节名称', '例如 用户标识与鉴别' ],
      [ '标准项编号', '条款唯一编号' ],
      [ '标准内容', '标准条款原文' ],
      [ '应用内容位置', '其他内容在项目页填写' ],
    ] },
  ];
  const result = parseStandardRows(sheets);
  assert.equal(result.itemCount, 1);
  assert.equal(result.importedSheetCount, 1);
  assert.equal(result.skippedSheetCount, 1);
  assert.deepEqual(result.chapters.map(chapter => chapter.name), [ '用户标识与鉴别' ]);
});

test('recognizes supervision workbook standard aliases', () => {
  const result = parseStandardRows([ { name: '标准目录', rows: [
    [ '标准编号', '标准子类', '级别', '标准要求' ],
    [ 6001, '6.1资源分配', '一般要求', '云服务商应确保资源可用性' ],
  ] } ]);
  assert.equal(result.itemCount, 1);
  assert.deepEqual([ result.chapters[0].code, result.chapters[0].name ], [ '6.1', '资源分配' ]);
  assert.equal(result.chapters[0].items[0].itemCode, '6001');
});

test('imports a variable-depth heading path without changing the standard item number', () => {
  const result = parseStandardRows([ { name: '多级标题', rows: [
    [ '章节编号', '章节名称', '标准项编号', '标准项标题', '标题路径', '标准内容' ],
    [ '6', '系统开发与供应链安全', '6.1.1 a)', '资源保护', '6.1 资源分配 > 6.1.1 一般要求 > 6.1.1.1 账号策略', '应保护资源。' ],
  ] } ]);
  const item = result.chapters[0].items[0];
  assert.equal(item.itemCode, '6.1.1 a)');
  assert.equal(item.title, '资源保护');
  assert.deepEqual(item.headingPath, [
    { level: 2, number: '6.1', title: '资源分配' },
    { level: 3, number: '6.1.1', title: '一般要求' },
    { level: 4, number: '6.1.1.1', title: '账号策略' },
  ]);
});

test('stores pre-list provider requirement as a parent clause explanation', () => {
  const result = parseStandardRows([ { name: '带父条款说明', rows: [
    [ '章节编号', '章节名称', '标题路径', '标准项编号', '标准项标题', '条款说明', '标准内容' ],
    [ '6', '系统开发与供应链', '6.1 资源分配 > 6.1.1 一般要求', '6.1.1 a)', '一般要求', '云服务商应：', '对保护信息系统和服务所需的资源进行分析；' ],
    [ '6', '系统开发与供应链', '6.1 资源分配 > 6.1.1 一般要求', '6.1.1 b)', '一般要求', '', '在预算管理过程中考虑网络安全资源需求。' ],
    [ '6', '系统开发与供应链', '6.1 资源分配 > 6.1.1 一般要求', '6.1.1 c)', '一般要求', '', '云服务商应对资源可用性进行复核。' ],
  ] } ]);
  assert.equal(result.chapters[0].items[0].explanation, '云服务商应：');
  assert.equal(result.chapters[0].items[0].content, '对保护信息系统和服务所需的资源进行分析；');
  assert.equal(result.chapters[0].items[1].explanation, undefined);
  assert.equal(result.chapters[0].items[2].content, '云服务商应对资源可用性进行复核。');
});

test('accepts a heading explanation row without a separate standard content cell', () => {
  const result = parseStandardRows([ { name: '标题解释', rows: [
    [ '章节编号', '章节名称', '标准项编号', '标准项标题', '条款说明', '标准内容' ],
    [ '6', '系统开发与供应链', '6.1.1', '一般要求', '云服务商应：', '' ],
  ] } ]);
  assert.equal(result.itemCount, 1);
  assert.equal(result.chapters[0].items[0].itemCode, '6.1.1');
  assert.equal(result.chapters[0].items[0].explanation, '云服务商应：');
  assert.equal(result.chapters[0].items[0].content, '云服务商应：');
});

test('continues heading depth after a subsection used as the imported chapter', () => {
  const result = parseStandardRows([ { name: '多级标题', rows: [
    [ '章节编号', '章节名称', '标准项编号', '标题路径', '标准内容' ],
    [ '8.1', '用户标识与鉴别', '8.1.1', '8.1.1 一般要求 > 8.1.1.1 账号策略', '应保护账号。' ],
  ] } ]);
  assert.deepEqual(result.chapters[0].items[0].headingPath, [
    { level: 3, number: '8.1.1', title: '一般要求' },
    { level: 4, number: '8.1.1.1', title: '账号策略' },
  ]);
});

test('rejects duplicate item codes across sheets after Unicode normalization', () => {
  const header = [ '章节编号', '章节名称', '标准项编号', '标准内容' ];
  const sheets = [
    { name: 'A', rows: [ header, [ '1', '第一章', 'A-1', '内容一' ] ] },
    { name: 'B', rows: [ header, [ '2', '第二章', 'Ａ－１', '内容二' ] ] },
  ];
  assert.throws(() => parseStandardRows(sheets), /标准项编号重复/);
});

test('comparison mode keeps the first duplicate item and reports skipped rows', () => {
  const header = [ '章节编号', '章节名称', '标准项编号', '标准内容' ];
  const result = parseStandardRows([
    { name: '持续监督检查问题清单', rows: [ header, [ '6.1', '系统开发与供应链安全', '6011', '第一条内容' ] ] },
    { name: '系统开发与供应链安全', rows: [ header, [ '6.1', '系统开发与供应链安全', '6011', '第二条内容' ], [ '6.1', '系统开发与供应链安全', '6012', '另一条内容' ] ] },
  ], { allowDuplicateItemCodes: true });
  assert.equal(result.itemCount, 2);
  assert.equal(result.duplicateItemCount, 1);
  assert.deepEqual(result.chapters[0].items.map(item => item.itemCode), [ '6011', '6012' ]);
  assert.equal(result.chapters[0].items[0].content, '第一条内容');
});

test('parses a TSV upload with quoted fields', async () => {
  const quote = String.fromCharCode(34);
  assert.deepEqual(parseDelimitedRows('A' + tab + 'B' + newline + 'x' + tab + quote + 'with' + tab + 'tab' + quote, tab), [ [ 'A', 'B' ], [ 'x', 'with' + tab + 'tab' ] ]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'standard-import-'));
  const filePath = path.join(directory, 'source.tsv');
  try {
    const rows = [
      [ '章节编号', '章节名称', '标题路径', '标准项编号', '标准项标题', '标准内容' ],
      [ '8', '用户标识与鉴别', '8.1 账号管理 > 8.1.1 身份认证 > 8.1.1.1 口令', '8.1.1', '账号管理', '账号管理要求' ],
    ];
    await fs.writeFile(filePath, rows.map(row => row.join(tab)).join(newline), 'utf8');
    const result = await parseStandardImportFile(filePath, 'source.tsv');
    assert.equal(result.itemCount, 1);
    assert.deepEqual(result.chapters[0].items[0], {
      itemCode: '8.1.1',
      title: '账号管理',
      content: '账号管理要求',
      headingPath: [
        { level: 2, number: '8.1', title: '账号管理' },
        { level: 3, number: '8.1.1', title: '身份认证' },
        { level: 4, number: '8.1.1.1', title: '口令' },
      ],
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('ignores invalid date values in unused workbook cells', () => {
  const result = parseStandardRows([ { name: '含日期列', rows: [
    [ '章节编号', '章节名称', '标准项编号', '标准内容', '检查日期' ],
    [ '8.1', '用户标识与鉴别', '8.1.1', '应建立账号管理要求', new Date(Number.NaN) ],
  ] } ]);
  assert.equal(result.itemCount, 1);
  assert.equal(result.chapters[0].items[0].itemCode, '8.1.1');
});

let ExcelJS;
let JSZip;
try {
  ExcelJS = require('exceljs');
  JSZip = require('jszip');
} catch {
  ExcelJS = null;
  JSZip = null;
}

test('parses xlsx workbooks with full-column data validations', { skip: !ExcelJS }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'standard-import-xlsx-'));
  const filePath = path.join(directory, 'source.xlsx');
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('标准条款');
    worksheet.addRow([ '章节编号', '章节名称', '标准项编号', '标准内容' ]);
    worksheet.addRow([ '8.1', '用户标识与鉴别', '8.1.1', '应建立账号管理要求' ]);
    worksheet.dataValidations.add('B2:B1048576', {
      type: 'list',
      allowBlank: true,
      formulae: [ '"是,否"' ],
    });
    await workbook.xlsx.writeFile(filePath);

    const result = await parseStandardImportFile(filePath, 'source.xlsx');
    assert.equal(result.itemCount, 1);
    assert.equal(result.chapters[0].items[0].itemCode, '8.1.1');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('parses xlsx files whose OOXML main parts use an x namespace prefix', { skip: !ExcelJS || !JSZip }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'standard-import-prefixed-xlsx-'));
  const filePath = path.join(directory, 'source.xlsx');
  try {
    const sourceWorkbook = new ExcelJS.Workbook();
    const worksheet = sourceWorkbook.addWorksheet('标准原文');
    worksheet.addRow([ '章节编号', '章节名称', '标准项编号', '标准内容' ]);
    worksheet.addRow([ '6', '系统开发与供应链安全', '6.1.1 a)', '云服务商应保护资源。' ]);
    const sourceBuffer = await sourceWorkbook.xlsx.writeBuffer();
    const archive = await JSZip.loadAsync(sourceBuffer);
    for (const name of Object.keys(archive.files).filter(item =>
      item === 'xl/workbook.xml' || item === 'xl/sharedStrings.xml' || item.startsWith('xl/worksheets/'))
    ) {
      const entry = archive.file(name);
      if (!entry) continue;
      const xml = await entry.async('string');
      const prefixed = xml.replace(/(<\/?)([A-Za-z_][A-Za-z0-9_.-]*)(?=[\s/>])/g, '$1x:$2')
        .replace(/xmlns="([^"]+)"/, 'xmlns:x="$1"');
      archive.file(name, prefixed);
    }
    await fs.writeFile(filePath, await archive.generateAsync({ type: 'nodebuffer' }));
    const result = await parseStandardImportFile(filePath, 'source.xlsx');
    assert.equal(result.itemCount, 1);
    assert.equal(result.chapters[0].items[0].itemCode, '6.1.1 a)');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the downloadable Excel template exposes and imports arbitrary-depth heading paths', { skip: !ExcelJS }, async () => {
  const templatePath = path.join(__dirname, '../app/public/standard-import-template.xlsx');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);
  const worksheet = workbook.getWorksheet('标准原文');
  assert.deepEqual(worksheet.getRow(1).values.slice(1), [ '章节编号', '章节名称', '标题路径', '标准项编号', '标准项标题', '条款说明', '标准内容' ]);
  assert.match(workbook.getWorksheet('填写说明').getCell('B9').value, /6\.1\.1\.1 账号策略/);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'standard-template-heading-path-'));
  const filePath = path.join(directory, 'template-sample.xlsx');
  try {
    worksheet.addRow([ '6', '系统开发与供应链安全', '6.1 资源分配 > 6.1.1 一般要求 > 6.1.1.1 账号策略', '6.1.1 a)', '账号管理', '云服务商应：', '应保护账号。' ]);
    await workbook.xlsx.writeFile(filePath);
    const result = await parseStandardImportFile(filePath, 'template-sample.xlsx');
    assert.deepEqual(result.chapters[0].items[0].headingPath, [
      { level: 2, number: '6.1', title: '资源分配' },
      { level: 3, number: '6.1.1', title: '一般要求' },
      { level: 4, number: '6.1.1.1', title: '账号策略' },
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('writes mapped standard fields inside one database transaction', async () => {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.split(newline).join(' ').trim();
      queries.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: null };
      if (statement.startsWith('INSERT INTO standards ')) return { rows: [ { id: 'standard-1', code: 'STD-1', name: '测试规范' } ] };
      if (statement.startsWith('INSERT INTO standard_versions ')) return { rows: [ { id: 'version-1', version: '2026' } ] };
      if (statement.startsWith('INSERT INTO standard_chapters ')) return { rows: [ { id: 'chapter-1' } ] };
      if (statement.startsWith('INSERT INTO standard_items ')) return { rows: [ { id: 'item-1', item_code: values[2] } ] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = new StandardCatalogRepository({ connect: async () => client });
  const result = await repository.importStandard({
    code: 'STD-1', name: '测试规范', standardType: 'national', version: '2026',
    chapters: [ { code: '8.1', name: '用户标识与鉴别', sortOrder: 0, items: [ {
      itemCode: '8.1.1', content: '账号管理要求', title: '账号管理',
      explanation: '云服务商应：',
      headingPath: [ { level: 3, number: '8.1.1', title: '一般要求' } ],
    } ] } ],
  });
  assert.equal(result.itemCount, 1);
  assert.ok(queries.some(query => query.statement === 'COMMIT'));
  const itemInsert = queries.find(query => query.statement.startsWith('INSERT INTO standard_items '));
  assert.deepEqual(itemInsert.values, [ 'version-1', 'chapter-1', '8.1.1', '账号管理', '云服务商应：', '账号管理要求', '[{"level":2,"number":"8.1","title":"用户标识与鉴别"},{"level":3,"number":"8.1.1","title":"一般要求"}]', 1, '1-2026-08001' ]);
  assert.equal(queries.some(query => query.statement.includes('standard_item_requirements')), false);
  assert.equal(queries.some(query => query.statement.includes('standard_provider_assignments')), false);
});

test('rolls back the whole standard import when an item insert fails', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      statements.push(statement);
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: null };
      if (statement.startsWith('INSERT INTO standards ')) return { rows: [ { id: 'standard-1', code: 'STD-1', name: '测试规范' } ] };
      if (statement.startsWith('INSERT INTO standard_versions ')) return { rows: [ { id: 'version-1', version: '2026' } ] };
      if (statement.startsWith('INSERT INTO standard_chapters ')) return { rows: [ { id: 'chapter-1' } ] };
      if (statement.startsWith('INSERT INTO standard_items ')) throw new Error('simulated item insert failure');
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = new StandardCatalogRepository({ connect: async () => client });
  await assert.rejects(repository.importStandard({
    code: 'STD-1', name: '测试规范', standardType: 'national', version: '2026',
    chapters: [ { code: '1', name: '总则', sortOrder: 0, items: [ { itemCode: '1.1', content: '内容' } ] } ],
  }), /simulated item insert failure/);
  assert.ok(statements.includes('ROLLBACK'));
  assert.equal(statements.includes('COMMIT'), false);
});

test('merges uploaded content into an existing version atomically', async () => {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      queries.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: null };
      if (statement === 'SELECT id FROM standard_versions WHERE id = $1 FOR UPDATE') {
        return { rows: [ { id: 'version-1' } ], rowCount: 1 };
      }
      if (statement === 'SELECT s.code, sv.version FROM standard_versions sv JOIN standards s ON s.id = sv.standard_id WHERE sv.id = $1') {
        return { rows: [ { code: 'GB/T 31168', version: '2023' } ], rowCount: 1 };
      }
      if (statement === 'SELECT id, code FROM standard_chapters WHERE standard_version_id = $1') {
        return { rows: [ { id: 'chapter-existing', code: '8.1' } ], rowCount: 1 };
      }
      if (statement.startsWith('INSERT INTO standard_chapters ')) {
        return { rows: [ { id: 'chapter-existing', code: '8' } ], rowCount: 1 };
      }
      if (statement === 'SELECT id, item_code FROM standard_items WHERE standard_version_id = $1') {
        return { rows: [ { id: 'item-existing', item_code: '8.1.1' } ], rowCount: 1 };
      }
      if (statement.startsWith('INSERT INTO standard_items ')) {
        return { rows: [
          { id: 'item-existing', item_code: '8.1.1' },
          { id: 'item-new', item_code: '8.1.2' },
        ], rowCount: 2 };
      }
      if (statement.startsWith('SELECT sv.version, s.code AS standard_code')) return { rows: [ { version: '2023', standard_code: 'GB/T 31168' } ], rowCount: 1 };
      if (statement.startsWith('SELECT id, code, sort_order FROM standard_chapters')) return { rows: [ { id: 'chapter-existing', code: '8', sort_order: 0 } ], rowCount: 1 };
      if (statement.startsWith('SELECT si.id, si.chapter_id, si.item_code')) return { rows: [], rowCount: 0 };
      if (statement.startsWith('UPDATE standard_chapters SET standard_number')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('UPDATE standard_items SET standard_number')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('DELETE FROM standard_item_requirements ')) return { rows: [], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = new StandardCatalogRepository({ connect: async () => client });
  const result = await repository.importVersionContent({
    versionId: 'version-1',
    chapters: [ { code: '8.1', name: '用户标识与鉴别', sortOrder: 0, items: [
      { itemCode: '8.1.1', title: '账号管理', content: '更新后的内容' },
      { itemCode: '8.1.2', title: null, content: '新增内容' },
    ] } ],
  });

  assert.deepEqual(result, { chapterCount: 1, itemCount: 2 });
  assert.ok(queries.some(query => query.statement === 'COMMIT'));
  const itemInsert = queries.find(query => query.statement.startsWith('INSERT INTO standard_items '));
  assert.ok(itemInsert.statement.includes('ON CONFLICT (standard_version_id, item_code) DO UPDATE'));
  assert.deepEqual(itemInsert.values, [
    'version-1', 'chapter-existing', '8.1.1', '账号管理', null, '更新后的内容', '[{"level":2,"number":"8.1","title":"用户标识与鉴别"}]', 1, 'TEMP-version-1-8.1.1',
    'version-1', 'chapter-existing', '8.1.2', null, null, '新增内容', '[{"level":2,"number":"8.1","title":"用户标识与鉴别"}]', 2, 'TEMP-version-1-8.1.2',
  ]);
  assert.equal(queries.some(query => query.statement.includes('standard_item_requirements')), false);
  assert.equal(queries.some(query => query.statement.includes('standard_provider_assignments')), false);
});

test('rolls back existing-version content import when the version is missing', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      statements.push(statement);
      if (statement === 'BEGIN' || statement === 'ROLLBACK') return { rows: [], rowCount: null };
      if (statement === 'SELECT id FROM standard_versions WHERE id = $1 FOR UPDATE') return { rows: [], rowCount: 0 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new StandardCatalogRepository({ connect: async () => client });
  const result = await repository.importVersionContent({
    versionId: 'missing-version',
    chapters: [ { code: '1', name: '总则', sortOrder: 0, items: [ { itemCode: '1.1', content: '内容' } ] } ],
  });
  assert.equal(result, null);
  assert.ok(statements.includes('ROLLBACK'));
  assert.equal(statements.includes('COMMIT'), false);
});
