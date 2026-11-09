'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStandardTree } = require('../app/lib/pdfStandardExtract');
const StandardImportJobRepository = require('../app/repository/standardImportJob');

function line(text, top, left = 100) {
  return { text, top, left, width: 500, height: 20, confidence: 93, pageHeight: 1200 };
}

test('builds selectable leaf clauses and preserves the original numbering hierarchy', () => {
  const result = buildStandardTree([
    { page: 1, width: 1000, lines: [
      line('目次', 100, 300),
      line('6.1 资源分配....................7', 200, 200),
    ] },
    { page: 7, width: 1000, lines: [
      line('1 范围', 100),
      line('本文件规定了云计算服务安全能力。', 150, 220),
      line('6 系统开发与供应链安全', 300),
      line('6.1 资源分配', 360),
      line('6.1.1 一般要求', 420),
      line('云服务商应：', 470, 220),
      line('a） 对 资 源 进 行 详 细 分 析 并 确 保 可 用 性 ;', 520, 220),
      line('b） 在 工 作 计 划 和 预 算 文 件 中 单 列 网 络 安 全 ;', 570, 220),
    ] },
  ]);

  const byNumber = new Map(result.nodes.map(node => [ node.originalNumber, node ]));
  assert.equal(byNumber.get('6.1').title, '资源分配');
  assert.equal(byNumber.get('6.1.1').title, '一般要求');
  assert.equal(byNumber.get('6.1.1 a)').kind, 'list');
  assert.equal(byNumber.get('6.1.1 a)').role, 'item');
  assert.equal(byNumber.get('6.1.1 b)').role, 'item');
  assert.equal(byNumber.get('6.1.1 a)').parentId, byNumber.get('6.1.1').id);
  assert.equal(byNumber.get('6.1.1').content, '云服务商应：');
  assert.equal(byNumber.get('6.1.1 a)').pageFrom, 7);
});

test('uses section 6.1 as chapter and aggregates skipped child content for a level-3 item', () => {
  const repository = new StandardImportJobRepository({});
  const nodes = [
    { id: 'n1', kind: 'heading', level: 1, originalNumber: '6', title: '系统开发与供应链安全', parentId: null, content: '' },
    { id: 'n2', kind: 'heading', level: 2, originalNumber: '6.1', title: '资源分配', parentId: 'n1', content: '' },
    { id: 'n3', kind: 'heading', level: 3, originalNumber: '6.1.1', title: '一般要求', parentId: 'n2', content: '云服务商应：' },
    { id: 'n4', kind: 'list', level: 4, originalNumber: '6.1.1 a)', parentId: 'n3', content: '对资源进行详细分析；' },
    { id: 'n5', kind: 'list', level: 4, originalNumber: '6.1.1 b)', parentId: 'n3', content: '预算中单列网络安全；' },
  ];
  const byId = new Map(nodes.map(node => [ node.id, node ]));
  const ancestors = repository.ancestors(nodes[2], byId);
  assert.equal(repository.chapterNode(ancestors, nodes[2]).originalNumber, '6.1');

  const children = new Map([ [ 'n3', [ nodes[3], nodes[4] ] ] ]);
  const selection = new Map([ [ 'n3', 'item' ], [ 'n4', 'skip' ], [ 'n5', 'skip' ] ]);
  assert.equal(repository.descendantContent('n3', children, selection), '对资源进行详细分析；\n预算中单列网络安全；');
});
