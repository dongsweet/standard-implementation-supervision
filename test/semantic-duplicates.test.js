'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSemanticPairs, termGroupsFor } = require('../app/lib/semanticDuplicates');

function plan(overrides = {}) {
  return {
    id: 'plan-a',
    plan_number: 1,
    object_name: 'EDR',
    object_category: '运维管理区',
    master_object_name: 'EDR',
    object_id: 'object-a',
    check_layer: '技术层面',
    check_method: '上机查看',
    description: '检查终端是否部署并运行终端检测与响应软件',
    steps: '查看终端安全控制台',
    frequency: '每季度',
    access_mode: '现场',
    standard_items: [
      {
        id: 'standard-a',
        standard_number: '31168-2023-08001',
        item_code: '8.1.1 a)',
        title: '恶意代码防护',
        content: '部署恶意代码防护软件并及时更新特征库',
        chapter_id: 'chapter-1',
        chapter_code: '8',
        chapter_name: '恶意代码防范',
      },
    ],
    ...overrides,
  };
}

test('recognizes EDR and antivirus as retrieval terms, not automatic identity', () => {
  assert.ok(termGroupsFor('EDR 终端检测与响应').length > 0);
  assert.ok(termGroupsFor('杀毒软件').length > 0);
  const pairs = buildSemanticPairs([
    plan(),
    plan({
      id: 'plan-b',
      plan_number: 2,
      object_name: '杀毒软件',
      master_object_name: '杀毒软件',
      object_id: 'object-b',
      description: '检查终端杀毒软件是否安装、运行并更新病毒库',
      standard_items: [{
        id: 'standard-b',
        standard_number: '31168-2023-08002',
        item_code: '8.1.1 b)',
        title: '病毒库更新',
        content: '终端应安装防病毒软件并保持病毒库更新',
        chapter_id: 'chapter-1',
        chapter_code: '8',
        chapter_name: '恶意代码防范',
      }],
    }),
  ], { minimumScore: 0.3 });
  assert.equal(pairs.length, 1);
  assert.match(pairs[0].recallReasons.join('；'), /同义业务术语/);
  assert.equal(pairs[0].left.id, 'plan-a');
  assert.equal(pairs[0].right.id, 'plan-b');
});

test('does not generate semantic candidates across different chapters', () => {
  const pairs = buildSemanticPairs([
    plan(),
    plan({
      id: 'plan-c',
      standard_items: [{
        id: 'standard-c',
        chapter_id: 'chapter-2',
        chapter_code: '9',
        chapter_name: '访问控制',
        content: 'EDR 终端检测与响应',
      }],
    }),
  ], { minimumScore: 0.1 });
  assert.deepEqual(pairs, []);
});
