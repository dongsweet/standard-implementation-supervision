'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStandardCorrections, parseStandardReviewSuggestions } = require('../app/lib/aiProvider');

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

test('filters smart review suggestions to known nodes and supported actions', () => {
  const suggestions = parseStandardReviewSuggestions(JSON.stringify({
    suggestions: [
      { nodeId: 'n1', action: 'adopt_comparison', confidence: 0.96, content: '对照正文', reason: '正文一致' },
      { nodeId: 'n1', action: 'bad_action', confidence: 0.9, content: '不应接受' },
      { nodeId: 'unknown', action: 'keep_ocr', confidence: 0.9, content: '不应接受' },
      { nodeId: 'n1', action: 'uncertain', confidence: 2, content: '置信度错误' },
    ],
  }), new Map([ [ 'n1', { id: 'n1', content: '当前正文' } ] ]));
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].action, 'adopt_comparison');
  assert.equal(suggestions[0].content, '对照正文');
});
