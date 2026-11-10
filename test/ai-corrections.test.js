'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStandardCorrections } = require('../app/lib/aiProvider');

test('filters AI corrections to known nodes and valid changed fields', () => {
  const corrections = parseStandardCorrections(JSON.stringify({
    corrections: [
      {
        nodeId: 'n1',
        originalNumber: '6.1.1 a)',
        title: '',
        content: '对保护信息系统和服务所需的资源进行详细分析。',
        confidence: 0.93,
        reason: '修正跨行空格',
      },
      {
        nodeId: 'unknown',
        originalNumber: '6.1.1 b)',
        content: '不应接受',
        confidence: 0.9,
      },
      {
        nodeId: 'n1',
        originalNumber: '',
        content: '缺少编号',
        confidence: 0.9,
      },
      {
        nodeId: 'n1',
        originalNumber: '6.1.1 a)',
        content: '置信度错误',
        confidence: 2,
      },
    ],
  }), new Set([ 'n1' ]));

  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].nodeId, 'n1');
  assert.equal(corrections[0].confidence, 0.93);
  assert.equal(corrections[0].content, '对保护信息系统和服务所需的资源进行详细分析。');
});
