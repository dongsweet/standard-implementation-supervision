'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAssignmentForm,
  normalizeDetails,
  placeholderTokens,
  splitOptions,
} = require('../app/lib/answerAssignment');

const standardText = '要求信息系统、组件或服务的开发商在开发过程的初始阶段定义质量度量标准，并以[选择：[赋值：云服务商定义的频率]；[赋值：云服务商定义的项目审查里程碑]；交付时]为节点，检查质量度量标准的落实情况；';
const existing = [
  {
    type: 'selection',
    label: '[赋值：云服务商定义的频率]；[赋值：云服务商定义的项目审查里程碑]；交付时',
    value: '云服务商定义的频率',
    selected: true,
    placeholder: '[选择：[赋值：云服务商定义的频率]；[赋值：云服务商定义的项目审查里程碑]；交付时]',
    placeholderId: '31168-2023-06042#1',
    parentSelectionId: null,
    reviewRequired: false,
  },
  {
    type: 'assignment',
    label: '云服务商定义的频率',
    value: '每年一次',
    selected: true,
    placeholder: '[赋值：云服务商定义的频率]',
    placeholderId: '31168-2023-06042#2',
    parentSelectionId: '31168-2023-06042#1',
    reviewRequired: false,
  },
  {
    type: 'assignment',
    label: '云服务商定义的项目审查里程碑',
    value: null,
    selected: false,
    placeholder: '[赋值：云服务商定义的项目审查里程碑]',
    placeholderId: '31168-2023-06042#3',
    parentSelectionId: '31168-2023-06042#1',
    reviewRequired: false,
  },
];

test('parses nested placeholders and keeps semicolons inside assignment brackets', () => {
  const tokens = placeholderTokens(standardText);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, 'selection');
  assert.deepEqual(splitOptions(tokens[0].body), [
    '[赋值：云服务商定义的频率]',
    '[赋值：云服务商定义的项目审查里程碑]',
    '交付时',
  ]);
});

test('builds a linked multi-select form for existing selection answers', () => {
  const form = buildAssignmentForm(standardText, existing);
  assert.equal(form.hasStructuredControls, true);
  assert.equal(form.controls.length, 1);
  const selection = form.controls[0];
  assert.equal(selection.kind, 'selection');
  assert.deepEqual(selection.options.map(option => option.label), [
    '云服务商定义的频率',
    '云服务商定义的项目审查里程碑',
    '交付时',
  ]);
  assert.deepEqual(selection.options.map(option => option.selected), [ true, false, false ]);
  assert.deepEqual(selection.options.map(option => option.assignmentValue), [ '每年一次', '', '' ]);
  assert.equal(selection.options[2].assignmentPlaceholder, '');
});

test('normalizes selected branches and never persists an unselected marker', () => {
  const result = normalizeDetails([ {
    type: 'selection',
    placeholderId: 'selection:1',
    selectedValues: [ '[赋值：云服务商定义的频率]' ],
    value: '[赋值：云服务商定义的频率]',
    selected: true,
  }, {
    type: 'assignment',
    placeholder: '[赋值：云服务商定义的频率]',
    placeholderId: 'selection:1:assignment:1',
    parentSelectionId: 'selection:1',
    label: '云服务商定义的频率',
    value: '每年一次',
    selected: true,
  } ], standardText);

  assert.equal(result.clauseAssignment, '选择：云服务商定义的频率\n云服务商定义的频率：每年一次');
  assert.equal(result.details.length, 2);
  assert.equal(result.details[0].type, 'selection');
  assert.deepEqual(result.details[0].selectedValues, [ '[赋值：云服务商定义的频率]' ]);
  assert.equal(result.details[1].parentSelectionId, 'selection:1');
  assert.equal(result.details.some(detail => detail.value === '未选中'), false);
});

test('supports selecting multiple options and their independent assignment values', () => {
  const result = normalizeDetails([ {
    type: 'selection',
    placeholderId: 'selection:1',
    selectedValues: [
      '[赋值：云服务商定义的频率]',
      '[赋值：云服务商定义的项目审查里程碑]',
    ],
    selected: true,
  }, {
    type: 'assignment',
    placeholder: '[赋值：云服务商定义的频率]',
    placeholderId: 'frequency',
    parentSelectionId: 'selection:1',
    label: '云服务商定义的频率',
    value: '每年一次',
    selected: true,
  }, {
    type: 'assignment',
    placeholder: '[赋值：云服务商定义的项目审查里程碑]',
    placeholderId: 'milestone',
    parentSelectionId: 'selection:1',
    label: '云服务商定义的项目审查里程碑',
    value: '设计评审',
    selected: true,
  } ], standardText);

  assert.equal(result.details.filter(detail => detail.type === 'selection').length, 1);
  assert.equal(result.details[0].selectedValues.length, 2);
  assert.equal(result.details.filter(detail => detail.type === 'assignment').length, 2);
  assert.match(result.clauseAssignment, /项目审查里程碑：设计评审/);
  assert.doesNotMatch(result.clauseAssignment, /未选中/);
});

test('does not create child assignment details for an unselected option', () => {
  const result = normalizeDetails([ {
    type: 'selection',
    placeholderId: 'selection:1',
    selectedValues: [ '[赋值：云服务商定义的频率]' ],
    selected: true,
  }, {
    type: 'assignment',
    placeholder: '[赋值：云服务商定义的项目审查里程碑]',
    placeholderId: 'milestone',
    parentSelectionId: 'selection:1',
    label: '云服务商定义的项目审查里程碑',
    value: '',
    selected: true,
  } ], standardText);

  assert.deepEqual(result.details.map(detail => detail.placeholder), [
    '[选择：[赋值：云服务商定义的频率]；[赋值：云服务商定义的项目审查里程碑]；交付时]',
    '[赋值：云服务商定义的频率]',
  ]);
});
