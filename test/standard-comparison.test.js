'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { diceSimilarity, mergeComparisonIntoTree, parseComparisonFile } = require('../app/lib/standardComparison');

function parsed(chapters) {
  return { chapters };
}

test('comparison parser accepts duplicate item codes across workbook rows', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'standard-comparison-'));
  const filePath = path.join(directory, 'comparison.tsv');
  try {
    await fs.writeFile(filePath, [
      '章节编号\t章节名称\t标准项编号\t标准内容',
      '6.1\t系统开发与供应链安全\t6011\t第一条内容',
      '6.1\t系统开发与供应链安全\t6011\t第二条内容',
    ].join('\n'), 'utf8');
    const result = await parseComparisonFile(filePath, 'comparison.tsv');
    assert.equal(result.itemCount, 1);
    assert.equal(result.duplicateItemCount, 1);
    assert.equal(result.chapters[0].items[0].content, '第一条内容');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('measures Chinese OCR text similarity deterministically', () => {
  assert.equal(diceSimilarity('应建立账号管理制度。', '应建立账号管理制度'), 1);
  assert.ok(diceSimilarity('应建立账号管理制度', '应建立统一账号管理制度') > 0.6);
  assert.equal(diceSimilarity('应建立账号管理制度', '检查机房温湿度'), 0);
});

test('normalizes frequent OCR phrase errors and does not cross clause markers', () => {
  assert.equal(
    diceSimilarity('根据扫描结果及时修复溥洞并采取有关掀施', '根据扫描结果及时修复漏洞并采取有关措施'),
    1
  );
  const tree = {
    nodes: [
      { id: 'h', kind: 'heading', level: 1, originalNumber: '8', title: '访问控制', content: '', parentId: null },
      { id: 'n', kind: 'list', originalNumber: '8.1.1 a)', content: '对用户进行唯一标识和鉴别', parentId: 'h' },
    ],
    warnings: [],
  };
  const result = mergeComparisonIntoTree(tree, parsed([
    {
      code: '访问控制', name: '访问控制', items: [
        { itemCode: '8001', content: 'b）对用户进行唯一标识和鉴别' },
      ],
    },
  ]));
  assert.equal(tree.nodes[1].comparisonMarkerConflict, true);
  assert.equal(tree.nodes[1].comparisonMatch, 'unmatched');
  assert.equal(result.matchedCount, 0);
});

test('aligns internal 6001-style numbering by chapter, sequence, and content', () => {
  const tree = {
    nodes: [
      { id: 'h0', kind: 'heading', level: 1, originalNumber: '6', title: '系统开发与供应链安全', content: '', parentId: null },
      { id: 'h1', kind: 'heading', level: 2, originalNumber: '6.1', title: '资源分配', content: '', parentId: 'h0' },
      { id: 'n1', kind: 'list', originalNumber: '6.1.1 a)', title: '', content: '对保护信息系统和服务所需资源进行详细分析并确保可用性', parentId: 'h1', role: 'item' },
      { id: 'n2', kind: 'list', originalNumber: '6.1.1 b)', title: '', content: '预算管理中对网络安全资源需求重点考虑并在计划中单列', parentId: 'h1', role: 'item' },
      { id: 'n3', kind: 'list', originalNumber: '6.1.1 c)', title: '', content: '实施可验证的缺陷修复过程', parentId: 'h1', role: 'item' },
      { id: 'n4', kind: 'list', originalNumber: '6.1.1 d)', title: '', content: '完全不同的条款', parentId: 'h1', role: 'item' },
    ],
    warnings: [],
  };
  const result = mergeComparisonIntoTree(tree, parsed([
    {
      code: '系统开发与供应链', name: '系统开发与供应链', items: [
        { itemCode: '6001', title: '资源分析', content: '对保护信息系统和服务所需资源进行详细分析并确保可用性' },
        { itemCode: '6002', title: '预算', content: '预算管理中对网络安全资源需求重点考虑并在计划中单列' },
        { itemCode: '6003', title: '缺陷', content: '实施可验证的缺陷修复流程' },
      ],
    },
  ]));

  assert.equal(tree.nodes[2].comparisonMatch, 'matched');
  assert.equal(tree.nodes[2].content, '对保护信息系统和服务所需资源进行详细分析并确保可用性');
  assert.equal(tree.nodes[2].comparisonItemCode, '6001');
  assert.equal(tree.nodes[2].comparisonMethod, 'sequence');
  assert.equal(tree.nodes[3].comparisonMatch, 'matched');
  assert.equal(tree.nodes[3].comparisonItemCode, '6002');
  assert.equal(tree.nodes[4].comparisonMatch, 'review');
  assert.equal(tree.nodes[4].content, '实施可验证的缺陷修复过程');
  assert.equal(tree.nodes[4].comparisonContent, '实施可验证的缺陷修复流程');
  assert.equal(tree.nodes[4].comparisonItemCode, '6003');
  assert.equal(tree.nodes[5].comparisonMatch, undefined);
  assert.equal(result.matchedCount, 2);
  assert.equal(result.reviewCount, 1);
  assert.equal(result.unmatchedCount, 1);
  assert.equal(result.unusedComparisonCount, 0);
  assert.equal(result.internalNumbering, true);
});

test('handles comparison workbooks with more rows than OCR nodes', () => {
  const tree = {
    nodes: [
      { id: 'h0', kind: 'heading', level: 1, originalNumber: '8', title: '访问控制', content: '', parentId: null },
      { id: 'n1', kind: 'list', originalNumber: '8.1 a)', content: '对用户进行唯一标识和鉴别', parentId: 'h0' },
    ],
    warnings: [],
  };
  const result = mergeComparisonIntoTree(tree, parsed([
    {
      code: '访问控制', name: '访问控制', items: [
        { itemCode: '8001', content: '对用户进行唯一标识和鉴别' },
        { itemCode: '8002', content: '另一条未出现在OCR中的条款' },
      ],
    },
  ]));
  assert.equal(tree.nodes[1].comparisonMatch, 'matched');
  assert.equal(tree.nodes[1].comparisonItemCode, '8001');
  assert.equal(result.unusedComparisonCount, 1);
});
