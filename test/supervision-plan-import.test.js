'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseSupervisionPlanRows, splitStandardNumbers } = require('../app/lib/supervisionPlanImport');
const { joinSupervisionMethods, splitSupervisionMethods } = require('../app/lib/supervisionMethods');
const { SupervisionPlanImportRepository } = require('../app/repository/supervisionPlanImport');

let ExcelJS;
let JSZip;
try {
  ExcelJS = require('exceljs');
  JSZip = require('jszip');
} catch {
  ExcelJS = null;
  JSZip = null;
}

test('normalizes multiple supervision methods without losing their individual values', () => {
  assert.deepEqual(splitSupervisionMethods('证据材料核查，上机查看/访谈'), [ '证据材料核查', '上机查看', '访谈' ]);
  assert.equal(joinSupervisionMethods([ '上机查看', '证据材料核查', '证据材料核查' ]), '证据材料核查,上机查看');
});

test('splits multi-standard cells without treating hyphens as separators', () => {
  assert.deepEqual(splitStandardNumbers('31168-2023-06008\n31168-2023-07002；31168-2023-07003'), {
    values: [ '31168-2023-06008', '31168-2023-07002', '31168-2023-07003' ],
    invalid: [],
    ignoredX: [],
  });
});

test('parses plan fields and keeps multiple standard links on one definition row', () => {
  const parsed = parseSupervisionPlanRows([
    { name: '填写说明', rows: [ [ '字段', '填写规则' ] ] },
    { name: '检查方案', rows: [
      [ '标准化编号', '是否公认对象', '检查范围', '对象分类', '检查对象', '检查层面', '检查方法', '检查项描述', '检查步骤', '检查频率', '重点项', '执行方式', '参考判定描述', '参考材料' ],
      [ '31168-2023-06008\n31168-2023-07002', '是', '云中心', '设计方案', '《云平台网络拓扑图》', '管理层面', '证据材料核查，上机查看', '检查云平台是否有安全边界', '检查物理和逻辑安全边界', '仅一次', '重点项', '远程', '应划定物理和逻辑安全边界', '拓扑图' ],
      [ '', '', '', '', '', '', '', '', '', '', '', '', '', '' ],
    ] },
  ]);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0].standardNumbers, [ '31168-2023-06008', '31168-2023-07002' ]);
  assert.equal(parsed.rows[0].recognizedObject, true);
  assert.equal(parsed.rows[0].scope, '');
  assert.deepEqual(parsed.rows[0].centers, [ '云中心' ]);
  assert.equal(parsed.rows[0].checkMethod, '证据材料核查,上机查看');
  assert.equal(parsed.rows[0].priority, '重点项');
  assert.equal(parsed.rows[0].referenceResult, '应划定物理和逻辑安全边界');
  assert.equal(parsed.importedSheetCount, 1);
  assert.equal(parsed.skippedSheetCount, 1);
});

test('maps original workbook headers into the editable plan fields', () => {
  const parsed = parseSupervisionPlanRows([ { name: '监督检查记录总表', rows: [
    [ '对应标准号', '是否公认对象', '检查项位于', '对象分类', '检查对象', '检查层面', '检查方法', '检查项描述', '检查步骤', '中心执行频率', '是否重点检查项', '远程/现场查看', '检查结果-参考描述', '证明材料（文档3参考）' ],
    [ '31168-2023-06008', '是', '统一运维中心', '内部统计', '下云用户数据删除记录', '管理层面', '证据材料核查', '检查记录是否完整', '核对删除记录', '每季度', '重点项', '现场', '记录应完整', '删除审批单及截图' ],
  ] } ]);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0].centers, [ '统一运维中心' ]);
  assert.equal(parsed.rows[0].scope, '');
  assert.equal(parsed.rows[0].recognizedObject, true);
  assert.equal(parsed.rows[0].frequency, '每季度');
  assert.equal(parsed.rows[0].priority, '重点项');
  assert.equal(parsed.rows[0].accessMode, '现场');
  assert.equal(parsed.rows[0].referenceResult, '记录应完整');
  assert.equal(parsed.rows[0].referenceMaterials, '删除审批单及截图');
});

test('merges applicable branches from repeated import rows into one definition', () => {
  const parsed = parseSupervisionPlanRows([ { name: '检查方案', rows: [
    [ '标准化编号', '检查范围', '适用机构', '检查对象', '检查方法', '检查项描述' ],
    [ '31168-2023-06008', '生产', '分支机构', '云平台账号', '证据材料核查', '核查高权限账号' ],
    [ '31168-2023-06009', '生产', '统一运维机构', '云平台账号', '证据材料核查', '核查高权限账号' ],
  ] } ]);
  assert.deepEqual(parsed.rows.map(row => row.centers), [ [ '云中心' ], [ '统一运维中心' ] ]);
  assert.equal(parsed.rows[0].scope, parsed.rows[1].scope);
});

test('ignores X-only rows and keeps valid system numbers from mixed cells', () => {
  const parsed = parseSupervisionPlanRows([ { name: '检查方案', rows: [
    [ '标准化编号', '检查对象', '检查方法', '检查项描述' ],
    [ 'X6001', '', '', '' ],
    [ 'X6002\n31168-2023-06008', '云平台', '证据核查', '检查内容' ],
  ] } ]);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0].standardNumbers, [ '31168-2023-06008' ]);
  assert.equal(parsed.ignoredXRowCount, 1);
  assert.equal(parsed.ignoredXNumberCount, 2);
});

test('ignores every identifier beginning with X, including mixed separators', () => {
  assert.deepEqual(splitStandardNumbers('X-6091\n31168-2023-06008'), {
    values: [ '31168-2023-06008' ], invalid: [], ignoredX: [ 'X-6091' ],
  });
});

test('rejects legacy IDs and incomplete plan rows', () => {
  assert.throws(() => parseSupervisionPlanRows([ { name: '检查方案', rows: [
    [ '标准化编号', '是否公认对象', '检查范围', '对象分类', '检查对象', '检查层面', '检查方法', '检查项描述' ],
    [ '6091', '否', '云中心', '设计方案', '网络拓扑图', '管理层面', '证据核查', '检查内容' ],
  ] } ]), /无效标准编号/);

  assert.throws(() => parseSupervisionPlanRows([ { name: '检查方案', rows: [
    [ '标准化编号', '检查对象', '检查方法', '检查项描述' ],
    [ '31168-2023-06008', '云平台', '', '检查内容' ],
  ] } ]), /缺少检查方法/);
});

test('rejects optional plan fields that exceed database column limits', () => {
  const tooLongFrequency = '年'.repeat(101);
  assert.throws(() => parseSupervisionPlanRows([ { name: '检查方案', rows: [
    [ '标准化编号', '检查对象', '检查方法', '检查项描述', '检查频率' ],
    [ '31168-2023-06008', '云平台', '证据材料核查', '检查内容', tooLongFrequency ],
  ] } ]), /检查频率.*超过100字限制/);
});

test('parses supervision workbooks whose OOXML main parts use an x namespace prefix', { skip: !ExcelJS || !JSZip }, async () => {
  const { parseSupervisionPlanFile } = require('../app/lib/supervisionPlanImport');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'supervision-plan-prefixed-xlsx-'));
  const filePath = path.join(directory, 'source.xlsx');
  try {
    const sourceWorkbook = new ExcelJS.Workbook();
    const sheet = sourceWorkbook.addWorksheet('检查方案');
    sheet.addRow([ '标准化编号', '检查对象', '检查方法', '检查项描述' ]);
    sheet.addRow([ '31168-2023-06008', '云平台', '证据材料核查', '检查内容' ]);
    const archive = await JSZip.loadAsync(await sourceWorkbook.xlsx.writeBuffer());
    for (const name of Object.keys(archive.files).filter(item =>
      item === 'xl/workbook.xml' || item === 'xl/sharedStrings.xml' || item.startsWith('xl/worksheets/'))) {
      const entry = archive.file(name);
      if (!entry) continue;
      const xml = await entry.async('string');
      const prefixed = xml.replace(/(<\/?)([A-Za-z_][A-Za-z0-9_.-]*)(?=[\s/>])/g, '$1x:$2')
        .replace(/xmlns="([^"]+)"/, 'xmlns:x="$1"');
      archive.file(name, prefixed);
    }
    await fs.writeFile(filePath, await archive.generateAsync({ type: 'nodebuffer' }));
    const result = await parseSupervisionPlanFile(filePath, 'source.xlsx');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].standardNumbers[0], '31168-2023-06008');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('imports plan definitions and multiple item links without creating executions', async () => {
  const statements = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      statements.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: null };
      if (statement.startsWith('SELECT * FROM supervision_plan_import_jobs')) {
        return { rows: [ { id: 'job-1', original_filename: 'plans.xlsx', status: 'ready', payload: { rows: [ {
          standardNumbers: [ '31168-2023-06008', '31168-2023-07002' ],
          objectName: '《云平台网络拓扑图》', scope: '云中心', recognizedObject: true,
          objectCategory: '设计方案', checkLayer: '管理层面', checkMethod: '证据材料核查',
          description: '检查云平台是否有安全边界', steps: '检查边界', frequency: '仅一次',
          accessMode: '远程', priority: '重点项', referenceResult: '应有边界', referenceMaterials: '拓扑图',
        } ] } } ], rowCount: 1 };
      }
      if (statement.includes('FROM standard_items si') && statement.includes('ANY($1::text[])')) {
        return { rows: [
          { id: 'item-1', standard_number: '31168-2023-06008' },
          { id: 'item-2', standard_number: '31168-2023-07002' },
        ], rowCount: 2 };
      }
      if (statement.startsWith('SELECT id, recognized_object')) return { rows: [], rowCount: 0 };
      if (statement.startsWith('INSERT INTO supervision_definitions')) return { rows: [ { id: 'definition-1' } ], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_definition_standard_items')) return { rows: [ { definition_id: 'definition-1' } ], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_definition_centers')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_object_categories')) return { rows: [ { id: 'category-1' } ], rowCount: 1 };
      if (statement.startsWith('SELECT id, category_id FROM supervision_objects')) return { rows: [], rowCount: 0 };
      if (statement.startsWith('INSERT INTO supervision_objects')) return { rows: [ { id: 'object-1' } ], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_object_aliases')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('UPDATE supervision_definitions SET canonical_object_id')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('UPDATE supervision_plan_import_jobs')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new SupervisionPlanImportRepository({ connect: async () => client });
  const result = await repository.apply('job-1', 'user-1');
  assert.equal(result.importedRowCount, 1);
  assert.equal(result.createdCount, 1);
  assert.equal(result.linkCount, 2);
  const audit = statements.find(item => item.statement.startsWith('INSERT INTO audit_logs'));
  assert.ok(audit);
  assert.equal(audit.values[0], 'user-1');
  assert.equal(audit.values[1], 'job-1');
  assert.deepEqual(JSON.parse(audit.values[2]), {
    originalFilename: 'plans.xlsx', importedRowCount: 1, createdCount: 1, reusedCount: 0, linkCount: 2,
  });
  assert.equal(statements.some(item => item.statement.includes('supervision_executions')), false);
  assert.equal(statements.some(item => item.statement.includes('supervision_item_results')), false);
});

test('merges otherwise identical plans while combining their applicable centers', async () => {
  const statements = [];
  const definitions = [];
  const links = new Set();
  const rows = [ '云中心', '总部', '云中心' ].map(center => ({
    standardNumbers: [ '31168-2023-06008' ],
    objectName: '《云平台网络拓扑图》', scope: '', centers: [ center ], recognizedObject: true,
    objectCategory: '设计方案', checkLayer: '管理层面', checkMethod: '证据材料核查',
    description: '检查云平台是否有安全边界', steps: '检查边界', frequency: '仅一次',
    accessMode: '远程', priority: '重点项', referenceResult: '', referenceMaterials: '',
  }));
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      statements.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: null };
      if (statement.startsWith('SELECT * FROM supervision_plan_import_jobs')) {
        return { rows: [ { id: 'job-scope', status: 'ready', payload: { rows } } ], rowCount: 1 };
      }
      if (statement.includes('FROM standard_items si') && statement.includes('ANY($1::text[])')) {
        return { rows: [ { id: 'item-1', standard_number: '31168-2023-06008' } ], rowCount: 1 };
      }
      if (statement.startsWith('SELECT id, recognized_object')) {
        return { rows: definitions.filter(definition => definition.normalizedHash === values[0]), rowCount: definitions.length };
      }
      if (statement.startsWith('INSERT INTO supervision_definitions')) {
        const id = `definition-${definitions.length + 1}`;
        definitions.push({
          id, scope: values[1], recognized_object: values[2], priority: values[10],
          access_mode: values[9], reference_result: values[11], reference_materials: values[12],
          normalizedHash: values[13],
        });
        return { rows: [ { id } ], rowCount: 1 };
      }
      if (statement.startsWith('INSERT INTO supervision_definition_standard_items')) {
        const key = `${values[0]}:${values[1]}`;
        if (links.has(key)) return { rows: [], rowCount: 0 };
        links.add(key);
        return { rows: [ { definition_id: values[0] } ], rowCount: 1 };
      }
      if (statement.startsWith('INSERT INTO supervision_definition_centers')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_object_categories')) return { rows: [ { id: 'category-1' } ], rowCount: 1 };
      if (statement.startsWith('SELECT id, category_id FROM supervision_objects')) return { rows: [], rowCount: 0 };
      if (statement.startsWith('INSERT INTO supervision_objects')) return { rows: [ { id: 'object-1' } ], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_object_aliases')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('UPDATE supervision_definitions SET canonical_object_id')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('UPDATE supervision_plan_import_jobs')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new SupervisionPlanImportRepository({ connect: async () => client });
  const result = await repository.apply('job-scope', 'user-1');
  assert.equal(result.importedRowCount, 3);
  assert.equal(result.createdCount, 1);
  assert.equal(result.linkCount, 1);
  assert.deepEqual(definitions.map(definition => definition.scope), [ null ]);
});

test('blocks the whole plan batch when a standard number cannot be resolved', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      statements.push(statement);
      if ([ 'BEGIN', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: null };
      if (statement.startsWith('SELECT * FROM supervision_plan_import_jobs')) {
        return { rows: [ { id: 'job-2', status: 'ready', payload: { rows: [ { standardNumbers: [ '31168-2023-06076', '31168-2023-99999' ] } ] } } ], rowCount: 1 };
      }
      if (statement.includes('FROM standard_items si') && statement.includes('ANY($1::text[])')) {
        return { rows: [ { id: 'item-1', standard_number: '31168-2023-06076' } ], rowCount: 1 };
      }
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new SupervisionPlanImportRepository({ connect: async () => client });
  await assert.rejects(repository.apply('job-2', 'user-1'), /未导入任何方案/);
  assert.equal(statements.some(statement => statement.startsWith('INSERT INTO supervision_definitions')), false);
  assert.equal(statements.includes('ROLLBACK'), true);
});
