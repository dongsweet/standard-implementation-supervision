'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSupervisionPlanRows, splitStandardNumbers } = require('../app/lib/supervisionPlanImport');
const { joinSupervisionMethods, splitSupervisionMethods } = require('../app/lib/supervisionMethods');
const { SupervisionPlanImportRepository } = require('../app/repository/supervisionPlanImport');

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
  assert.equal(parsed.rows[0].scope, '云中心');
  assert.equal(parsed.rows[0].checkMethod, '证据材料核查,上机查看');
  assert.equal(parsed.rows[0].priority, '重点项');
  assert.equal(parsed.rows[0].referenceResult, '应划定物理和逻辑安全边界');
  assert.equal(parsed.importedSheetCount, 1);
  assert.equal(parsed.skippedSheetCount, 1);
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

test('imports plan definitions and multiple item links without creating executions', async () => {
  const statements = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      statements.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: null };
      if (statement.startsWith('SELECT * FROM supervision_plan_import_jobs')) {
        return { rows: [ { id: 'job-1', status: 'ready', payload: { rows: [ {
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
      if (statement.startsWith('SELECT id, scope, recognized_object')) return { rows: [], rowCount: 0 };
      if (statement.startsWith('INSERT INTO supervision_definitions')) return { rows: [ { id: 'definition-1' } ], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_definition_standard_items')) return { rows: [ { definition_id: 'definition-1' } ], rowCount: 1 };
      if (statement.startsWith('UPDATE supervision_plan_import_jobs')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new SupervisionPlanImportRepository({ connect: async () => client });
  const result = await repository.apply('job-1', 'user-1');
  assert.equal(result.importedRowCount, 1);
  assert.equal(result.createdCount, 1);
  assert.equal(result.linkCount, 2);
  assert.equal(statements.some(item => item.statement.includes('supervision_executions')), false);
  assert.equal(statements.some(item => item.statement.includes('supervision_item_results')), false);
});

test('keeps otherwise identical plans separate when their scopes differ', async () => {
  const statements = [];
  const definitions = [];
  const links = new Set();
  const rows = [ '云中心', '总部', '云中心' ].map(scope => ({
    standardNumbers: [ '31168-2023-06008' ],
    objectName: '《云平台网络拓扑图》', scope, recognizedObject: true,
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
      if (statement.startsWith('SELECT id, scope, recognized_object')) {
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
      if (statement.startsWith('UPDATE supervision_plan_import_jobs')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new SupervisionPlanImportRepository({ connect: async () => client });
  const result = await repository.apply('job-scope', 'user-1');
  assert.equal(result.importedRowCount, 3);
  assert.equal(result.createdCount, 2);
  assert.equal(result.linkCount, 2);
  assert.deepEqual(definitions.map(definition => definition.scope), [ '云中心', '总部' ]);
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
