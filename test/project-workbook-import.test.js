'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProjectRows, parseAnswerWorkbookRows, parseStatus, splitEvidence } = require('../app/lib/projectWorkbookImport');
const { ProjectWorkbookImportRepository } = require('../app/repository/projectWorkbookImport');
const { parseSubmittedAssignmentText } = require('../app/lib/answerAssignment');
let ExcelJS;
let buildProjectAnswerWorkbook;
try {
  ExcelJS = require('exceljs');
  ({ buildProjectAnswerWorkbook } = require('../app/lib/projectAnswerTemplate'));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

test('generates blank answer sheets grouped by readable standard name', { skip: !ExcelJS }, async () => {
  const buffer = await buildProjectAnswerWorkbook({ rows: [
    {
      standardNumber: '31168-2023-06042', clauseNumber: '6.8.2 b)',
      standard_code: 'GB/T 31168', standard_name: '信息安全技术 云计算服务安全能力要求', standard_version: '2023',
      assignmentText: '不应导出的现有应答', complianceDescription: '不应导出的现有描述', actualEvidence: '不应导出的现有证据',
    },
    {
      standardNumber: 'OTHER-2026-001', clauseNumber: '1.1',
      standard_code: 'OTHER', standard_name: '其他安全规范', standard_version: '2026',
    },
  ] });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), [
    '填写说明', '信息安全技术 云计算服务安全能力要求', '其他安全规范',
  ]);
  const summary = workbook.getWorksheet('信息安全技术 云计算服务安全能力要求');
  assert.deepEqual(summary.getRow(2).values.slice(1), [
    '条款号', '是否重点项', '应答赋值', '制度符合性描述',
    '实际证据', '适用性标记', '符合性标记', '备注', '标准化编号',
  ]);
  assert.equal(summary.getCell('A3').value, '6.8.2 b)');
  assert.equal(summary.getCell('I3').value, '31168-2023-06042');
  assert.equal(summary.getColumn(9).hidden, true);
  assert.deepEqual(
    [ 2, 3, 4, 5, 6, 7, 8 ].map(column => summary.getRow(3).getCell(column).value || ''),
    [ '', '', '', '', '', '', '' ]
  );

  const sheets = workbook.worksheets.map(sheet => ({
    name: sheet.name,
    rows: Array.from({ length: sheet.rowCount }, (_, rowIndex) =>
      sheet.getRow(rowIndex + 1).values.slice(1).map(value => value == null ? null : String(value))),
  }));
  const parsed = parseAnswerWorkbookRows(sheets);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].assignmentText, '');
  assert.equal(parsed.rows[0].complianceDescription, '');
  assert.equal(parsed.rows[0].actualEvidence, '');
  assert.equal(parsed.rows[1].standardNumber, 'OTHER-2026-001');
});

test('parses human-readable response text into structured selection and assignment details', () => {
  const source = '要求以[选择：[赋值：云服务商定义的频率]；[赋值：云服务商定义的项目审查里程碑]；交付时]为节点，并检查落实情况。';
  const details = parseSubmittedAssignmentText(
    source,
    '选择：云服务商定义的频率\n云服务商定义的频率：每年一次'
  );
  assert.equal(details.length, 2);
  assert.equal(details[0].type, 'selection');
  assert.deepEqual(details[0].selectedValues, [ '[赋值：云服务商定义的频率]' ]);
  assert.equal(details[1].type, 'assignment');
  assert.equal(details[1].label, '云服务商定义的频率');
  assert.equal(details[1].value, '每年一次');
  assert.equal(details[1].reviewRequired, false);
});

test('parses legacy human-readable selection text containing a nested placeholder', () => {
  const source = '达到[选择：[赋值：云服务商定义的时间段]；立即执行]后继续。';
  const details = parseSubmittedAssignmentText(
    source,
    '选择项：达到[赋值：云服务商定义的时间段]\n云服务商定义的时间段：30分钟'
  );
  assert.equal(details.length, 2);
  assert.equal(details[0].type, 'selection');
  assert.equal(details[1].type, 'assignment');
  assert.equal(details[1].value, '30分钟');
});

test('parses the wide project workbook shape into answers, cloud groups and supervision data', () => {
  const result = parseProjectRows([ {
    name: '安全域',
    rows: [
      [ '标准项编号', '章节号', '章节名称', '标准号', '标准名称', '级别号', '级别', '条款号', '标准内容', '是否为重点项', '应答赋值', null, null, null, null, null, null, null, null, null, null, null, null, '待提供证据', '问题列', '负责人', null, null, null, null, null, null ],
      [ null, null, null, null, null, null, null, null, null, null, null, '制度符合性描述', '所需证据', '满足情况', '安全措施运行情况描述', '举证', '满足情况', '安全措施运行情况描述', '举证', '满足情况', '安全措施运行情况描述', '举证', null, null, null, null, '监督检查措施', '监督检查内容-统一运维', '监督检查结果-统一运维', '监督检查内容-抚州', '监督检查结果-抚州', '监督检查内容-新疆', '监督检查结果-新疆' ],
      [ 6001, '6', '系统开发与供应链安全', 'GB/T 31168', '云计算服务安全能力要求', '6.1.1', '一般要求', '6.1.1 a)', '标准正文', '是', '云服务商', '统一要求', '证据列表', '满足', '措施A', '证据A\n无', '部分满足', '措施B', '证据B', '不满足', '措施C', '证据C', null, '待提供', '问题A', '张三', '检查频率：年度\n检查方法：材料核查', '统一运维检查内容\n2025/09/20', '符合', '抚州检查内容\n2025/07/01', '符合', '新疆检查内容', '不满足' ],
    ],
  } ]);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.cloudCenterNames, [ '统一运维中心', '抚州', '新疆' ]);
  assert.equal(result.rows[0].clauseNumber, '6.1.1 a)');
  assert.equal(result.rows[0].cloudCenters['统一运维中心'].status.status, 'satisfied');
  assert.equal(result.rows[0].cloudCenters['抚州'].status.status, 'partially_satisfied');
  assert.equal(result.rows[0].supervision.length, 1);
  assert.equal(result.rows[0].supervision[0].method, '材料核查');
  assert.equal(result.rows[0].supervision[0].observations.length, 3);
});

test('reads the current answer headers', () => {
  const result = parseProjectRows([ {
    name: '当前表头',
    rows: [
      [ '标准项编号', '章节号', '章节名称', '标准号', '标准名称', '级别号', '级别', '条款号', '标准内容', '是否为重点项', '应答赋值', null, null, null, null, null, null, null, null, null, null, null, null, '待提供证据', '问题列', '负责人', null, null, null, null, null, null ],
      [ null, null, null, null, null, null, null, null, null, null, null, '制度符合性描述', '所需证据', '满足情况', '安全措施运行情况描述', '举证', '满足情况', '安全措施运行情况描述', '举证', '满足情况', '安全措施运行情况描述', '举证', null, null, null, null, '监督检查措施', null, null, null, null, null, null ],
      [ 6001, '6', '系统开发与供应链', 'GB/T 31168', '云计算服务安全能力要求', '6.1.1', '一般要求', '6.1.1 a)', '标准正文', '是', '应答赋值A', '制度符合性描述A', '所需证据A', '符合', '措施A', '证据A', '符合', '措施B', '证据B', '符合', '措施C', '证据C', null, '待提供', '问题A', '张三', '检查频率：年度', null, null, null, null, null, null ],
    ],
  } ]);
  assert.equal(result.rows[0].providerAssignment, '应答赋值A');
  assert.equal(result.rows[0].complianceDescription, '制度符合性描述A');
  assert.equal(result.rows[0].expectedEvidence, '所需证据A');
});

test('normalizes simple status and skips default empty evidence', () => {
  assert.equal(parseStatus('不符合').status, 'not_satisfied');
  assert.equal(parseStatus('不适用').applicability, 'not_applicable');
  assert.deepEqual(splitEvidence('默认：无'), []);
  assert.deepEqual(splitEvidence('证据1\n无\n证据2'), [ '证据1', '证据2' ]);
});

test('parses the standard answer workbook and keeps assignment details per placeholder', () => {
  const result = parseAnswerWorkbookRows([
    {
      name: 'Sheet1',
      rows: [
        [ '标准化编号', '项目表序号(A列)', '应答赋值', '制度符合性描述', '所需证据' ],
        [ '31168-2023-06033', 6026, '1、采购合同\n2、安全协议', '制度要求', '制度文件A' ],
        [ '31168-2023-08037', null, '云服务商定义的强制实施的访问控制策略：\n1、租户默认策略', '', '' ],
      ],
    },
    {
      name: '赋值提取复核',
      rows: [
        [ '标准化编号', '项目表序号(A列)', '原文占位符', '提取类型', '当前赋值', '制度符合性描述', '实际证据', '需要复核', '复核原因' ],
        [ '31168-2023-06033', 6026, '[赋值：云服务商定义的安全要求]', '赋值', '1、采购合同\n2、安全协议', '制度要求', '制度文件A', '是', '已提取占位符；当前赋值可能对应一个或多个占位符。' ],
        [ '31168-2023-08037', null, '[赋值：云服务商定义的强制实施的访问控制策略]', '赋值', '云服务商定义的强制实施的访问控制策略：\n1、租户默认策略', '', '', '否', '用户确认：说明项保留赋值。' ],
      ],
    },
  ]);
  assert.equal(result.importMode, 'answer');
  assert.equal(result.rows.length, 2);
  assert.equal(result.assignmentDetailCount, 2);
  assert.equal(result.rows.find(row => row.standardNumber === '31168-2023-06033').assignmentDetails[0].value, '采购合同\n安全协议');
  assert.equal(result.rows.find(row => row.standardNumber === '31168-2023-08037').assignmentDetails[0].reviewRequired, false);
});

test('maps labeled depth, coverage, and choice values to their own placeholders', () => {
  const result = parseAnswerWorkbookRows([
    { name: '汇总', rows: [
      [ '标准化编号', '制度符合性描述', '实际证据' ],
      [ '31168-2023-06062', '落实系统测试。', '测试报告' ],
    ] },
    { name: '赋值提取复核', rows: [
      [ '标准化编号', '提取类型', '需赋值项或选择项', '原文占位符', '当前赋值', '需要复核', '复核原因' ],
      [ '31168-2023-06062', '赋值', '云服务商定义的深度和覆盖面', '[赋值：云服务商定义的深度和覆盖面]', '深度：漏洞扫描、渗透测试、关键代码审计\n广度：云平台所有关键组件\n选择：系统', '是', '已提取占位符；当前赋值可能对应一个或多个占位符，需逐项核对并拆分保存。' ],
      [ '31168-2023-06062', '选择', '单元；集成；系统；回归', '[选择：单元；集成；系统；回归]', '深度：漏洞扫描、渗透测试、关键代码审计\n广度：云平台所有关键组件\n选择：系统', '是', '已提取占位符；当前赋值可能对应一个或多个占位符，需逐项核对并拆分保存。' ],
    ] },
  ]);
  const row = result.rows[0];
  assert.equal(row.assignmentDetails[0].value, '深度：漏洞扫描、渗透测试、关键代码审计\n广度：云平台所有关键组件');
  assert.equal(row.assignmentDetails[1].value, '系统');
  assert.equal(row.assignmentDetails[0].reviewRequired, false);
  assert.equal(row.assignmentDetails[1].reviewRequired, false);
});

test('renders selected nested choice and omits inactive child values from the summary', () => {
  const result = parseAnswerWorkbookRows([
    { name: '汇总', rows: [
      [ '标准化编号', '制度符合性描述', '实际证据' ],
      [ '31168-2023-06042', '依据每年一次检查质量度量标准。', '检查记录' ],
    ] },
    { name: '赋值提取复核', rows: [
      [ '标准化编号', '占位符ID', '提取类型', '需赋值项或选择项', '原文占位符', '当前赋值', '所属选择项ID', '是否选中/生效', '对应占位符的当前值', '需要复核', '复核原因' ],
      [ '31168-2023-06042', '31168-2023-06042#1', '选择', '[赋值：云服务商定义的频率]；[赋值：云服务商定义的项目审查里程碑]；交付时', '[选择：[赋值：云服务商定义的频率]；[赋值：云服务商定义的项目审查里程碑]；交付时]', '云服务商定义的频率', '', '是', '云服务商定义的频率', '否', '' ],
      [ '31168-2023-06042', '31168-2023-06042#2', '赋值', '云服务商定义的频率', '[赋值：云服务商定义的频率]', '每年一次', '31168-2023-06042#1', '是', '每年一次', '否', '' ],
      [ '31168-2023-06042', '31168-2023-06042#3', '赋值', '云服务商定义的项目审查里程碑', '[赋值：云服务商定义的项目审查里程碑]', '每年一次', '31168-2023-06042#1', '否', '', '否', '' ],
    ] },
  ]);
  const row = result.rows[0];
  assert.equal(row.assignmentDetails[0].label, '选择');
  assert.equal(row.assignmentDetails[0].value, '[赋值：云服务商定义的频率]');
  assert.deepEqual(row.assignmentDetails[0].selectedValues, [ '[赋值：云服务商定义的频率]' ]);
  assert.equal(row.assignmentDetails[1].value, '每年一次');
  assert.equal(row.assignmentDetails[1].parentSelectionId, '31168-2023-06042#1');
  assert.equal(row.assignmentDetails.length, 2);
  assert.equal(row.assignmentDetails.some(detail => detail.label === '云服务商定义的项目审查里程碑'), false);
  assert.equal(row.assignmentText, '选择：云服务商定义的频率\n云服务商定义的频率：每年一次');
  assert.doesNotMatch(row.assignmentText, /项目审查里程碑|未选中/);
  assert.doesNotMatch(row.assignmentText, /待确认/);
});

test('compares imported source text against the reconstructed parent explanation and clause body', async () => {
  const repository = new ProjectWorkbookImportRepository({
    async query(sql) {
      if (sql.includes('FROM project_cloud_centers')) return { rows: [] };
      if (sql.includes('FROM project_standard_items')) return { rows: [ {
        standard_item_id: 'item-1', item_code_snapshot: '6.1.1 a)', standard_number_snapshot: '31168-2023-06001',
        explanation_snapshot: '云服务商应：', content_snapshot: '对资源进行分析并确保可用性；',
      } ] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  });
  repository.getJob = async () => ({ payload: { rows: [ {
    sourceSheet: '章节6', sourceRow: 3, clauseNumber: '6.1.1 a)',
    content: '云服务商应：\n对资源进行分析并确保可用性；', supervision: [],
  } ] } });

  const review = await repository.getReview('project-1', 'job-1');
  assert.equal(review.summary.matchedCount, 1);
  assert.equal(review.summary.contentDifferenceCount, 0);
});

test('revalidates assignments against the current standard and drops stale semicolon warnings', async () => {
  const repository = new ProjectWorkbookImportRepository({
    async query(sql) {
      if (sql.includes('FROM project_cloud_centers')) return { rows: [] };
      if (sql.includes('FROM project_standard_versions psv')) return { rows: [ {
        id: 'item-12004', item_code: '12.1.1 c)', standard_number: '31168-2023-12004',
        explanation: null, content: '按照[赋值：云服务商定义的频率]，审查事件处理计划。',
      } ] };
      if (sql.includes('FROM project_standard_items')) return { rows: [ {
        standard_item_id: 'item-12004', item_code_snapshot: '12.1.1 c)', standard_number_snapshot: '31168-2023-12004',
        explanation_snapshot: null, content_snapshot: '按照[赋值：云服务商定义的频率]，审查事件处理计划。',
      } ] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  });
  repository.getJob = async () => ({ payload: { importMode: 'answer', rows: [ {
    sourceKind: 'answer', sourceSheet: '应答汇总', sourceRow: 2, standardNumber: '31168-2023-12004',
    assignmentText: '云服务商定义的频率：一年一次',
    assignmentDetails: [ {
      type: 'assignment', label: '云服务商定义的频率', placeholder: '[赋值;云服务商定义的频率]',
      placeholderId: 'assignment:1', parentSelectionId: null, value: '一年一次', selected: true,
      reviewRequired: true, reviewReason: '赋值占位符使用分号作为提示与说明的分隔符，建议在系统条款编辑中修正为中文冒号。',
    } ],
  } ] } });
  repository.listProjectCloudCenters = async () => [];
  repository.listProjectStandardItems = async () => [ {
    standard_item_id: 'item-12004', item_code_snapshot: '12.1.1 c)', standard_number_snapshot: '31168-2023-12004',
    explanation_snapshot: null, content_snapshot: '按照[赋值;云服务商定义的频率],审查事件处理计划。',
  } ];
  const review = await repository.getReview('project-1', 'job-1');
  assert.equal(review.summary.assignmentReviewCount, 0);
  assert.equal(review.matches[0].assignmentDetails[0].value, '一年一次');
  assert.equal(review.matches[0].assignmentDetails[0].reviewRequired, false);
  assert.equal(review.matches[0].assignmentDetails[0].reviewReason, null);
});

test('does not import an assignment value when the matched standard item has no assignment placeholder', async () => {
  const repository = new ProjectWorkbookImportRepository({ query: async () => ({ rows: [] }) });
  repository.getJob = async () => ({ payload: { importMode: 'answer', rows: [ {
    sourceKind: 'answer', sourceSheet: 'Sheet1', sourceRow: 120, standardNumber: '31168-2023-12055',
    assignmentText: '赋值：每日', assignmentDetails: [], complianceDescription: '制度要求', expectedEvidence: '制度文件',
  } ] } });
  repository.listProjectCloudCenters = async () => [];
  repository.listProjectStandardItems = async () => [ {
    standard_item_id: 'item-12055', item_code_snapshot: '12.5.5', standard_number_snapshot: '31168-2023-12055',
    explanation_snapshot: null, content_snapshot: '普通条款，不含占位符。',
  } ];
  const review = await repository.getReview('project-1', 'job-1');
  assert.equal(review.summary.matchedCount, 1);
  assert.equal(review.matches[0].assignmentText, '');
  assert.equal(review.matches[0].assignmentDetails.length, 0);
  assert.equal(Object.hasOwn(review.summary, 'assignmentIgnoredCount'), false);
});

test('does not match an answer to a parent explanation absent from the project snapshot', async () => {
  const repository = new ProjectWorkbookImportRepository({ query: async () => ({ rows: [] }) });
  repository.getJob = async () => ({ payload: { importMode: 'answer', rows: [ {
    sourceKind: 'answer', sourceSheet: 'Sheet1', sourceRow: 12, standardNumber: '31168-2023-08037',
    assignmentText: '云服务商定义的强制实施的访问控制策略：租户默认策略', assignmentDetails: [],
  } ] } });
  repository.listProjectCloudCenters = async () => [];
  repository.listProjectStandardItems = async () => [ {
    standard_item_id: 'item-08038', item_code_snapshot: '8.1.1 a)', standard_number_snapshot: '31168-2023-08038',
    explanation_snapshot: '云服务商应：', content_snapshot: '执行访问控制。',
  } ];
  repository.listProjectSourceItems = async () => [
    { id: 'item-08037', item_code: '8.1.1', standard_number: '31168-2023-08037', explanation: '[赋值：云服务商定义的强制实施的访问控制策略]', content: '[赋值：云服务商定义的强制实施的访问控制策略]', chapter_code: '8' },
    { id: 'item-08038', item_code: '8.1.1 a)', standard_number: '31168-2023-08038', explanation: '云服务商应：', content: '执行访问控制。', chapter_code: '8' },
  ];
  const review = await repository.getReview('project-1', 'job-1');
  assert.equal(review.summary.matchedCount, 0);
  assert.equal(review.summary.unmatchedCount, 1);
  assert.equal(review.summary.snapshotMissingCount, 1);
  assert.match(review.unmatched[0].reason, /项目快照缺少此项/);
});

test('writes assignment details, implementation requirements, and real evidence in answer-import mode', async () => {
  const calls = [];
  const payload = { importMode: 'answer', rows: [ {
    sourceKind: 'answer', standardNumber: '31168-2023-06033', clauseNumber: '6.3.1 a)',
    assignmentText: '云服务商定义的安全要求：采购合同',
    assignmentDetails: [ { type: 'assignment', label: '云服务商定义的安全要求', placeholder: '[赋值：云服务商定义的安全要求]', placeholderId: '31168-2023-06033#1', parentSelectionId: null, selected: true, value: '采购合同', reviewRequired: false } ],
    complianceDescription: '制定统一要求。', expectedEvidence: '', actualEvidence: '《采购管理规范》',
    cloudCenters: {}, supervision: [],
  } ] };
  const client = {
    async query(sql, values) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (statement.includes('FROM project_data_import_jobs') && statement.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [ { id: 'job-1', status: 'ready', original_filename: 'answers.xlsx', payload, cloud_mapping: {} } ] };
      }
      if (statement.includes('FROM project_cloud_centers')) return { rowCount: 0, rows: [] };
      if (statement.includes('WITH project_items AS')) return { rowCount: 1, rows: [ {
        standard_item_id: 'item-1', source_item_id: 'item-1', item_code_snapshot: '6.3.1 a)', standard_number_snapshot: '31168-2023-06033',
        explanation_snapshot: null, content_snapshot: '采购合同中提出安全要求[赋值：云服务商定义的安全要求]。',
        item_code: '6.3.1 a)', standard_number: '31168-2023-06033',
        explanation: null, content: '采购合同中提出安全要求[赋值：云服务商定义的安全要求]。',
        snapshot_missing: false,
      } ] };
      if (statement.includes('FROM project_standard_items')) return { rowCount: 1, rows: [ {
        standard_item_id: 'item-1', item_code_snapshot: '6.3.1 a)', standard_number_snapshot: '31168-2023-06033',
        explanation_snapshot: null, content_snapshot: '采购合同中提出安全要求[赋值：云服务商定义的安全要求]。',
      } ] };
      if (statement.startsWith('INSERT INTO project_standard_answers')) return { rowCount: 1, rows: [ { id: 'answer-1' } ] };
      if (statement.startsWith('INSERT INTO evidence_materials')) return { rowCount: 1, rows: [ { id: 'evidence-1' } ] };
      if (statement.startsWith('INSERT INTO answer_evidence')) return { rowCount: 1, rows: [] };
      if (statement.startsWith('UPDATE project_data_import_jobs')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${statement}`);
    },
    release() {},
  };
  const repository = new ProjectWorkbookImportRepository({ connect: async () => client });
  const result = await repository.apply({
    projectId: 'project-1', jobId: 'job-1', cloudCenterIds: [ null ],
    acknowledgeUnmatched: false, acknowledgeContentDifferences: false,
    acknowledgeAssignmentReview: false, actorId: 'user-1',
  });
  const answerWrite = calls.find(call => call.statement.startsWith('INSERT INTO project_standard_answers'));
  assert.ok(answerWrite);
  assert.equal(JSON.parse(answerWrite.values[4])[0].value, '采购合同');
  assert.equal(JSON.parse(answerWrite.values[4])[0].placeholderId, '31168-2023-06033#1');
  assert.equal(JSON.parse(answerWrite.values[4])[0].selected, true);
  assert.equal(answerWrite.values[5], '制定统一要求。');
  assert.equal(answerWrite.values[7], '《采购管理规范》');
  assert.equal(answerWrite.values[8], 'unspecified');
  assert.equal(answerWrite.values[9], 'unassessed');
  assert.equal(answerWrite.values[13], true);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.evidenceCount, 1);
  assert.equal(result.cloudAnswerCount, 0);
});

test('does not add a missing parent standard item during answer import', async () => {
  const calls = [];
  const payload = { importMode: 'answer', rows: [ {
    sourceKind: 'answer', standardNumber: '31168-2023-08037',
    assignmentText: '强制实施的访问控制策略：租户默认策略',
    assignmentDetails: [ { type: 'assignment', label: '云服务商定义的强制实施的访问控制策略', placeholder: '[赋值：云服务商定义的强制实施的访问控制策略]', value: '租户默认策略', reviewRequired: false } ],
    cloudCenters: {}, supervision: [],
  } ] };
  const client = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push(statement);
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rowCount: 0, rows: [] };
      if (statement.includes('FROM project_data_import_jobs') && statement.includes('FOR UPDATE')) return { rowCount: 1, rows: [ { status: 'ready', payload, original_filename: 'answers.xlsx' } ] };
      if (statement.includes('FROM project_cloud_centers')) return { rowCount: 0, rows: [] };
      if (statement.startsWith('WITH project_items AS')) return { rowCount: 2, rows: [
        { standard_item_id: 'parent-08037', source_item_id: 'parent-08037', item_code_snapshot: '8.1.1', standard_number_snapshot: '31168-2023-08037', explanation_snapshot: '[赋值：云服务商定义的强制实施的访问控制策略]', content_snapshot: '[赋值：云服务商定义的强制实施的访问控制策略]', item_code: '8.1.1', standard_number: '31168-2023-08037', snapshot_missing: true, chapter_code: '8' },
        { standard_item_id: 'clause-08038', source_item_id: 'clause-08038', item_code_snapshot: '8.1.1 a)', standard_number_snapshot: '31168-2023-08038', explanation_snapshot: '云服务商应：', content_snapshot: '执行访问控制。', item_code: '8.1.1 a)', standard_number: '31168-2023-08038', snapshot_missing: false, chapter_code: '8' },
      ] };
      if (statement.startsWith('INSERT INTO project_standard_items')) return { rowCount: 1, rows: [ { standard_item_id: 'parent-08037' } ] };
      if (statement.startsWith('INSERT INTO project_standard_answers')) return { rowCount: 1, rows: [ { id: 'answer-08037' } ] };
      if (statement.startsWith('UPDATE project_data_import_jobs')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${statement}`);
    },
    release() {},
  };
  const repository = new ProjectWorkbookImportRepository({ connect: async () => client });
  await assert.rejects(
    repository.apply({
      projectId: 'project-1', jobId: 'job-1', cloudCenterIds: [],
      acknowledgeUnmatched: false, acknowledgeContentDifferences: false,
      acknowledgeAssignmentReview: false, actorId: 'user-1',
    }),
    error => error.code === 'PROJECT_IMPORT_UNMATCHED',
  );
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(calls.some(statement => statement.startsWith('INSERT INTO project_standard_items')), false);
  assert.equal(calls.some(statement => statement.startsWith('INSERT INTO project_standard_answers')), false);
});

test('blocks unresolved assignment links until the reviewer acknowledges them', async () => {
  const calls = [];
  const payload = { importMode: 'answer', rows: [ {
    sourceKind: 'answer', standardNumber: '31168-2023-06033', clauseNumber: '6.3.1 a)',
    assignmentText: '云服务商定义的安全要求：x', assignmentDetails: [ {
      type: 'assignment', label: '云服务商定义的安全要求', placeholder: '[赋值：某项]',
      value: 'x', reviewRequired: true, reviewReason: '请确认映射。',
    } ],
    cloudCenters: {}, supervision: [],
  } ] };
  const client = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push(statement);
      if ([ 'BEGIN', 'ROLLBACK' ].includes(statement)) return { rowCount: 0, rows: [] };
      if (statement.includes('FROM project_data_import_jobs') && statement.includes('FOR UPDATE')) return { rowCount: 1, rows: [ { status: 'ready', payload } ] };
      if (statement.includes('FROM project_cloud_centers')) return { rowCount: 0, rows: [] };
      if (statement.includes('WITH project_items AS')) return { rowCount: 1, rows: [ {
        standard_item_id: 'item-1', source_item_id: 'item-1', item_code_snapshot: '6.3.1 a)',
        standard_number_snapshot: '31168-2023-06033', explanation_snapshot: null, content_snapshot: '条款[赋值：某项]',
        item_code: '6.3.1 a)', standard_number: '31168-2023-06033', explanation: null,
        content: '条款[赋值：某项]', snapshot_missing: false,
      } ] };
      if (statement.includes('FROM project_standard_items')) return { rowCount: 1, rows: [ { standard_item_id: 'item-1', item_code_snapshot: '6.3.1 a)', standard_number_snapshot: '31168-2023-06033', explanation_snapshot: null, content_snapshot: '条款[赋值：某项]' } ] };
      throw new Error(`Unexpected query: ${statement}`);
    },
    release() {},
  };
  const repository = new ProjectWorkbookImportRepository({ connect: async () => client });
  await assert.rejects(
    repository.apply({ projectId: 'project-1', jobId: 'job-1', cloudCenterIds: [], acknowledgeUnmatched: false, acknowledgeContentDifferences: false, acknowledgeAssignmentReview: false }),
    error => error.code === 'PROJECT_IMPORT_ASSIGNMENT_REVIEW',
  );
  assert.equal(calls.some(statement => statement.startsWith('INSERT INTO project_standard_answers')), false);
});
