'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSplitGroups, validateSplitDraft } = require('../app/lib/objectSplit');

test('builds split groups from historical plan categories', () => {
  const groups = buildSplitGroups([
    { id: 'p37', plan_number: 37, object_category: '业务平台' },
    { id: 'p62', plan_number: 62, object_category: '运维管理区' },
    { id: 'p429', plan_number: 429, object_category: '内部统计' },
    { id: 'p449', plan_number: 449, object_category: '业务平台' },
    { id: 'p684', plan_number: 684, object_category: '业务平台' },
    { id: 'p829', plan_number: 829, object_category: '业务平台' },
  ]);
  assert.deepEqual(groups.map(group => [ group.category, group.planNumbers ]), [
    [ '业务平台', [ 37, 449, 684, 829 ] ],
    [ '内部统计', [ 429 ] ],
    [ '运维管理区', [ 62 ] ],
  ]);
});

test('validates editable split names, categories, and plan assignment', () => {
  const valid = validateSplitDraft({
    sourceName: '零信任',
    groups: [
      { name: '运维零信任', category: '运维管理区', planIds: [ 'a', 'b' ] },
      { name: '业务零信任', category: '业务平台', planIds: [ 'c' ] },
    ],
  });
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.assignedPlanCount, 3);

  const invalid = validateSplitDraft({
    sourceName: '零信任',
    groups: [
      { name: '零信任', category: '运维管理区', planIds: [ 'a' ] },
      { name: '业务零信任', category: '', planIds: [ 'a' ] },
    ],
  });
  assert.match(invalid.errors.join('；'), /不能与来源对象/);
  assert.match(invalid.errors.join('；'), /缺少分类/);
  assert.match(invalid.errors.join('；'), /被分配到多个分组/);
});
