'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStandardReviewSuggestions } = require('../app/lib/aiProvider');

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
