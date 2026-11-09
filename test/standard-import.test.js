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
    [ '标准名称', '标准项编号', '标准项标题', '标准内容', '级别', '是否为重点项', '云服务商赋值', '适用云服务商', '统管分组', '统管分组', '应答', '监督' ],
    [ '', '', '', '', '', '', '', '', '多云统管体系具体要求', '统一规范实施证据列表', '满足情况', '检查频率' ],
    [ '8.1 用户标识与鉴别', '8.1.1', '账号管理', '应建立账号管理要求', '三级', '是', '全部云服务商', '华为云、阿里云', '统一账号策略', '制度、配置截图', '满足', '每年' ],
    [ '', '8.1.2', '身份鉴别', '应采用身份鉴别措施', '三级', '否', '重点云服务商', '腾讯云', '', '', '部分满足', '每季度' ],
  ] } ]);
  assert.equal(result.itemCount, 2);
  assert.deepEqual([ result.chapters[0].code, result.chapters[0].name ], [ '8.1', '用户标识与鉴别' ]);
  assert.equal(result.chapters[0].items[0].unifiedRequirement, '统一账号策略');
  assert.equal(result.chapters[0].items[0].implementationEvidence, '制度、配置截图');
  assert.equal(result.chapters[0].items[0].providerAssignment, '全部云服务商');
  assert.deepEqual(result.chapters[0].items[0].providerNames, [ '华为云', '阿里云' ]);
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

test('rejects duplicate item codes across sheets after Unicode normalization', () => {
  const header = [ '章节编号', '章节名称', '标准项编号', '标准内容' ];
  const sheets = [
    { name: 'A', rows: [ header, [ '1', '第一章', 'A-1', '内容一' ] ] },
    { name: 'B', rows: [ header, [ '2', '第二章', 'Ａ－１', '内容二' ] ] },
  ];
  assert.throws(() => parseStandardRows(sheets), /标准项编号重复/);
});

test('parses a TSV upload with quoted fields', async () => {
  const quote = String.fromCharCode(34);
  assert.deepEqual(parseDelimitedRows('A' + tab + 'B' + newline + 'x' + tab + quote + 'with' + tab + 'tab' + quote, tab), [ [ 'A', 'B' ], [ 'x', 'with' + tab + 'tab' ] ]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'standard-import-'));
  const filePath = path.join(directory, 'source.tsv');
  try {
    const rows = [
      [ '章节编号', '章节名称', '标准项编号', '标准项标题', '标准内容', '是否为重点项', '云服务商赋值', '适用云服务商', '多云统管体系具体要求', '统一规范实施证据列表' ],
      [ '8.1', '用户标识与鉴别', '8.1.1', '账号管理', '账号管理要求', '是', '全部', '云A|云B', '统一策略', '制度文件' ],
    ];
    await fs.writeFile(filePath, rows.map(row => row.join(tab)).join(newline), 'utf8');
    const result = await parseStandardImportFile(filePath, 'source.tsv');
    assert.equal(result.itemCount, 1);
    assert.equal(result.chapters[0].items[0].implementationEvidence, '制度文件');
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
      itemCode: '8.1.1', content: '账号管理要求', isKey: true, providerAssignment: '全部云服务商',
      providerNames: [ '云A' ], unifiedRequirement: '统一策略', implementationEvidence: '制度文件',
    } ] } ],
  });
  assert.equal(result.itemCount, 1);
  assert.ok(queries.some(query => query.statement === 'COMMIT'));
  const itemInsert = queries.find(query => query.statement.startsWith('INSERT INTO standard_items '));
  assert.equal(JSON.parse(itemInsert.values[7]).providerAssignment, '全部云服务商');
  assert.deepEqual(queries.find(query => query.statement.startsWith('INSERT INTO standard_provider_assignments ')).values, [ 'item-1', '云A' ]);
  assert.deepEqual(queries.find(query => query.statement.startsWith('INSERT INTO standard_item_requirements ')).values, [ 'item-1', '统一策略', '制度文件' ]);
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
      if (statement === 'SELECT id, code FROM standard_chapters WHERE standard_version_id = $1') {
        return { rows: [ { id: 'chapter-existing', code: '8.1' } ], rowCount: 1 };
      }
      if (statement.startsWith('INSERT INTO standard_chapters ')) {
        return { rows: [ { id: 'chapter-existing', code: '8.1' } ], rowCount: 1 };
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
      if (statement.startsWith('DELETE FROM standard_provider_assignments ')) return { rows: [], rowCount: 2 };
      if (statement.startsWith('DELETE FROM standard_item_requirements ')) return { rows: [], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = new StandardCatalogRepository({ connect: async () => client });
  const result = await repository.importVersionContent({
    versionId: 'version-1',
    chapters: [ { code: '8.1', name: '用户标识与鉴别', sortOrder: 0, items: [
      { itemCode: '8.1.1', content: '更新后的内容', providerNames: [ '云A' ], unifiedRequirement: '统一策略' },
      { itemCode: '8.1.2', content: '新增内容', implementationEvidence: '制度文件' },
    ] } ],
  });

  assert.deepEqual(result, { chapterCount: 1, itemCount: 2 });
  assert.ok(queries.some(query => query.statement === 'COMMIT'));
  const itemInsert = queries.find(query => query.statement.startsWith('INSERT INTO standard_items '));
  assert.ok(itemInsert.statement.includes('ON CONFLICT (standard_version_id, item_code) DO UPDATE'));
  assert.deepEqual(itemInsert.values.slice(0, 8), [ 'version-1', 'chapter-existing', '8.1.1', null, '更新后的内容', null, false, '{}' ]);
  const providerInsert = queries.find(query => query.statement.startsWith('INSERT INTO standard_provider_assignments '));
  assert.deepEqual(providerInsert.values, [ 'item-existing', '云A' ]);
  const requirementInsert = queries.find(query => query.statement.startsWith('INSERT INTO standard_item_requirements '));
  assert.deepEqual(requirementInsert.values, [ 'item-existing', '统一策略', null, 'item-new', '', '制度文件' ]);
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
