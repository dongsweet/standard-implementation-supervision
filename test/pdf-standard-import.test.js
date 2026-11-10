'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { assessTextLayer, buildStandardTree, findBodyStartPage, layoutTextToPages, listPdfImages, mapWithConcurrency, progressForStage } = require('../app/lib/pdfStandardExtract');
const StandardImportJobRepository = require('../app/repository/standardImportJob');

function line(text, top, left = 100) {
  return { text, top, left, width: 500, height: 20, confidence: 93, pageHeight: 1200 };
}

test('reports text-layer, render, and OCR progress stages', () => {
  assert.equal(progressForStage(0, 77, 'text-check'), 2);
  assert.equal(progressForStage(77, 77, 'text-done'), 95);
  assert.equal(progressForStage(0, 77, 'render'), 4);
  assert.equal(progressForStage(0, 77, 'ocr'), 10);
  assert.equal(progressForStage(38, 77, 'ocr'), 52);
  assert.equal(progressForStage(77, 77, 'ocr'), 95);
});

test('accepts readable text layers and rejects garbled pseudo-text layers', () => {
  const readable = layoutTextToPages([
    '1 范围',
    '本文件规定了云计算服务安全能力要求。',
    '2 规范性引用文件',
    'GB/T 31167—2023 信息安全技术 云计算服务安全指南',
    '6 系统开发与供应链安全',
    '6.1 资源分配',
    '6.1.1 一般要求',
    '云服务商应：',
    'a) 对保护信息系统和服务所需的资源进行详细分析，并确保这些资源的可用性；',
  ].join('\n'), 1);
  assert.equal(assessTextLayer(readable).usable, true);

  const garbled = layoutTextToPages([
    '!"# !""#$"%&%!',
    'e¦zg,',
    '&&&Ii¾R¹"SÄ+=>[\'95678,',
    '&&&mÝu956¦O*',
    'odÖë_ý«uP569234de9¦O+2defQª.563K+ïð/êlR)*uI',
  ].join('\n'), 1);
  const quality = assessTextLayer(garbled);
  assert.equal(quality.usable, false);
  assert.ok(quality.reasons.length > 0);
});

test('maps actual Poppler image filenames to page numbers without padding assumptions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-pages-'));
  try {
    await Promise.all([ 'page-01.jpg', 'page-02.jpg', 'page-10.jpg' ].map(name => fs.writeFile(path.join(directory, name), '')));
    assert.deepEqual(await listPdfImages(directory), [ 'page-01.jpg', 'page-02.jpg', 'page-10.jpg' ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('runs OCR pages concurrently while preserving input order', async () => {
  let active = 0;
  let peak = 0;
  const progress = [];
  const worker = async value => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  };
  worker.progress = async (completed, total) => progress.push([ completed, total ]);
  const result = await mapWithConcurrency([ 1, 2, 3, 4, 5, 6 ], 3, worker);
  assert.deepEqual(result, [ 2, 4, 6, 8, 10, 12 ]);
  assert.equal(peak, 3);
  assert.equal(progress.length, 6);
  assert.deepEqual(progress.at(-1), [ 6, 6 ]);
});

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

test('skips table-of-contents headings and repairs common OCR list marker confusions', () => {
  const pages = [
    { page: 2, width: 1000, lines: [
      line('1 范围........1', 100),
      line('6.1 资源分配........7', 200),
      line('6 系统开发与供应链安全ssssssssss 7', 250),
    ] },
    { page: 8, width: 1000, lines: [
      line('1 苑图', 100),
      line('2 规范性引用文件', 150),
      line('3 术语和定义', 200),
      line('6 系统开发与供应链安全', 300),
      line('6.3 采购过程', 350),
      line('6.3.1 一般要求', 400),
      line('云服务商应：', 450, 220),
      line('a）第一项要求；', 500, 220),
      line('b）第二项要求；', 550, 220),
      line('o）第三项要求；', 600, 220),
    ] },
  ];
  assert.equal(findBodyStartPage(pages), 8);
  const result = buildStandardTree(pages);
  assert.equal(result.nodes.filter(node => node.pageFrom === 2).length, 0);
  assert.equal(result.nodes.find(node => node.originalNumber === '1').title, '苑图');
  assert.equal(result.nodes.find(node => node.originalNumber === '6.3.1 c)').content, '第三项要求；');
  assert.equal(result.nodes.some(node => node.originalNumber === '6.3.1 o)'), false);
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
