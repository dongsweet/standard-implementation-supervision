'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProjectRows, parseStatus, splitEvidence } = require('../app/lib/projectWorkbookImport');

test('parses the wide project workbook shape into answers, cloud groups and supervision data', () => {
  const result = parseProjectRows([ {
    name: '安全域',
    rows: [
      [ '标准项编号', '章节号', '章节名称', '标准号', '标准名称', '级别号', '级别', '条款号', '标准内容', '是否为重点项', '云服务商赋值', null, null, null, null, null, null, null, null, null, null, null, null, '待提供证据', '问题列', '负责人', null, null, null, null, null, null ],
      [ null, null, null, null, null, null, null, null, null, null, null, '多云统管制度规范体系具体要求', '统一规范实施证据列表', '满足情况', '安全措施运行情况描述', '举证', '满足情况', '安全措施运行情况描述', '举证', '满足情况', '安全措施运行情况描述', '举证', null, null, null, null, '监督检查措施', '监督检查内容-统一运维', '监督检查结果-统一运维', '监督检查内容-抚州', '监督检查结果-抚州', '监督检查内容-新疆', '监督检查结果-新疆' ],
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

test('normalizes simple status and skips default empty evidence', () => {
  assert.equal(parseStatus('不符合').status, 'not_satisfied');
  assert.equal(parseStatus('不适用').applicability, 'not_applicable');
  assert.deepEqual(splitEvidence('默认：无'), []);
  assert.deepEqual(splitEvidence('证据1\n无\n证据2'), [ '证据1', '证据2' ]);
});
