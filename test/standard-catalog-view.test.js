'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  filterChapters,
  hasAssignmentPlaceholder,
  paginateChapters,
  paginateItems,
} = require('../app/lib/standardCatalogView');

const chapters = [
  {
    id: 'chapter-1', code: '6', name: '系统开发', item_count: 3,
    items: [
      { id: 'item-1', standardNumber: '31168-2023-06001', itemCode: '6.1.1', title: '一般要求', explanation: '云服务商应：', content: '應在［賦值：云服务商定义的频率］检查。', headingPath: [] },
      { id: 'item-2', standardNumber: '31168-2023-06002', itemCode: '6.1.1 a)', title: '一般要求', explanation: null, content: '检查资源可用性。', headingPath: [] },
      { id: 'item-3', standardNumber: '31168-2023-06003', itemCode: '6.1.1 b)', title: '一般要求', explanation: null, content: '对[选择：组件]执行审计。', headingPath: [] },
    ],
  },
  {
    id: 'chapter-2', code: '7', name: '通信保护', item_count: 1,
    items: [
      { id: 'item-4', standardNumber: '31168-2023-07001', itemCode: '7.1.1', title: '安全通信', explanation: null, content: '按照[赋值:云服务商定义的时间段]检查。', headingPath: [] },
    ],
  },
];

test('detects assignment placeholders after Unicode compatibility normalization', () => {
  assert.equal(hasAssignmentPlaceholder({ content: '在［赋值：云服务商定义的频率］内检查。' }), true);
  assert.equal(hasAssignmentPlaceholder({ content: '对[选择：组件]执行审计。' }), false);
  assert.equal(hasAssignmentPlaceholder({ explanation: '云服务商应满足[赋值:时间段]。' }), true);
});

test('filters assignable items and text search across clause fields', () => {
  const assigned = filterChapters(chapters, { needsAssignment: true });
  assert.deepEqual(assigned.map(chapter => chapter.code), [ '6', '7' ]);
  assert.deepEqual(assigned.flatMap(chapter => chapter.items.map(item => item.id)), [ 'item-1', 'item-4' ]);

  const searched = filterChapters(chapters, { search: '资源可用性' });
  assert.equal(searched.length, 1);
  assert.deepEqual(searched[0].items.map(item => item.id), [ 'item-2' ]);
});

test('paginates matching chapters without losing page counts', () => {
  const filtered = filterChapters(chapters, { needsAssignment: true });
  const firstPage = paginateChapters(filtered, 1, '1');
  assert.deepEqual(firstPage.chapters.map(chapter => chapter.code), [ '6' ]);
  assert.equal(firstPage.pagination.pageCount, 2);
  assert.equal(firstPage.chapters[0].item_count, 1);
});

test('paginates standard items across chapter boundaries and groups the page by chapter', () => {
  const firstPage = paginateItems(chapters, 1, '20');
  assert.equal(firstPage.pagination.total, 4);
  assert.equal(firstPage.pagination.pageCount, 1);
  assert.deepEqual(firstPage.chapters.map(chapter => chapter.code), [ '6', '7' ]);
  assert.deepEqual(firstPage.chapters.flatMap(chapter => chapter.items.map(item => item.id)), [ 'item-1', 'item-2', 'item-3', 'item-4' ]);
});

test('splits a large standard-item result into stable pages', () => {
  const manyItems = [
    { ...chapters[0], items: Array.from({ length: 30 }, (_, index) => ({ id: `a-${index + 1}` })) },
    { ...chapters[1], items: Array.from({ length: 25 }, (_, index) => ({ id: `b-${index + 1}` })) },
  ];
  const firstPage = paginateItems(manyItems, 1, '50');
  const secondPage = paginateItems(manyItems, 2, '50');
  assert.equal(firstPage.pagination.total, 55);
  assert.equal(firstPage.pagination.pageCount, 2);
  assert.equal(firstPage.pagination.lastItem, 50);
  assert.equal(secondPage.pagination.firstItem, 51);
  assert.equal(secondPage.pagination.lastItem, 55);
  assert.deepEqual(secondPage.chapters.map(chapter => chapter.code), [ '7' ]);
  assert.equal(secondPage.chapters[0].items.length, 5);
});
