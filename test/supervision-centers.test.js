'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSupervisionCenters } = require('../app/lib/supervisionCenters');
const { normalizeDefinition, definitionConflicts } = require('../app/lib/dedupe');
const { planImportKey } = require('../app/repository/supervisionPlanImport');

test('parses and canonicalizes multiple applicable supervision centers', () => {
  assert.deepEqual(splitSupervisionCenters('云中心，统一运维、总部；云中心'), [ '云中心', '统一运维中心', '总部' ]);
  assert.deepEqual(splitSupervisionCenters([ '云中心', '总部' ]), [ '云中心', '总部' ]);
});

test('center differences do not change definition identity or create a metadata conflict', () => {
  const common = {
    object_name: '云平台账号', object_category: '技术', check_layer: '配置',
    check_method: '证据材料核查', description: '核查高权限账号', steps: '核对账号清单', frequency: '年度',
  };
  assert.equal(normalizeDefinition({ ...common, centers: [ '云中心' ] }).normalizedHash,
    normalizeDefinition({ ...common, centers: [ '统一运维中心' ] }).normalizedHash);
  assert.deepEqual(definitionConflicts(
    { ...common, scope: null, centers: [ '云中心' ] },
    { ...common, scope: null, centers: [ '统一运维中心' ] }
  ), []);
});

test('plan import identity keeps scope semantics but excludes applicable centers', () => {
  const fields = { scope: '生产环境', recognized_object: true, priority: '重点项' };
  assert.equal(planImportKey('hash', { ...fields, centers: [ '云中心' ] }),
    planImportKey('hash', { ...fields, centers: [ '总部' ] }));
  assert.notEqual(planImportKey('hash', fields), planImportKey('hash', { ...fields, scope: '测试环境' }));
});
