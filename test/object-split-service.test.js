'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let Service;
try {
  Service = require('../app/service/supervisionDefinition');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function createService(repository) {
  const service = Object.create(Service.prototype);
  Object.defineProperty(service, 'repository', { value: repository });
  service.ctx = {
    throw(status, message) {
      const error = new Error(message);
      error.status = status;
      throw error;
    },
  };
  return service;
}

const sourceId = '7218dd53-92cc-4fff-89d1-e96be152fb17';

test('saves a complete split draft with plan snapshots and category ids', { skip: !Service }, async () => {
  let saved;
  const service = createService({
    async listObjectCategories() {
      return [
        { id: 'category-ops', name: '运维管理区' },
        { id: 'category-business', name: '业务平台' },
      ];
    },
    async findActiveObjectNameConflict() {
      return null;
    },
    async createObjectSplitDraft(payload) {
      saved = payload;
      return { id: 'draft-1', ...payload };
    },
  });
  service.objectSplitPreview = async () => ({
    object: { id: sourceId, canonical_name: '零信任', status: 'active' },
    plans: [
      { id: 'plan-62', plan_number: 62, object_name: '零信任', object_category: '运维管理区', description: '运维方案', centers: [ '云中心' ] },
      { id: 'plan-37', plan_number: 37, object_name: '零信任', object_category: '业务平台', description: '业务方案', centers: [ '总部' ] },
    ],
  });
  const draft = await service.saveObjectSplitDraft(sourceId, {
    groups: [
      { name: '运维零信任', category: '运维管理区', planIds: [ 'plan-62' ] },
      { name: '业务零信任', category: '业务平台', planIds: [ 'plan-37' ] },
    ],
  }, 'user-1');
  assert.equal(draft.id, 'draft-1');
  assert.deepEqual(saved.groups.map(group => group.categoryId), [ 'category-ops', 'category-business' ]);
  assert.equal(saved.groups[0].plans[0].plan_number, 62);
  assert.equal(saved.groups[1].plans[0].plan_number, 37);
});

test('rejects a draft that omits or reassigns source plans', { skip: !Service }, async () => {
  const service = createService({
    async listObjectCategories() { return []; },
    async findActiveObjectNameConflict() { return null; },
  });
  service.objectSplitPreview = async () => ({
    object: { id: sourceId, canonical_name: '零信任', status: 'active' },
    plans: [
      { id: 'plan-62', plan_number: 62, object_category: '运维管理区' },
      { id: 'plan-37', plan_number: 37, object_category: '业务平台' },
    ],
  });
  await assert.rejects(service.saveObjectSplitDraft(sourceId, {
    groups: [
      { name: '运维零信任', category: '运维管理区', planIds: [ 'plan-62' ] },
      { name: '业务零信任', category: '业务平台', planIds: [ 'plan-62' ] },
    ],
  }, 'user-1'), /多个分组|必须且只能分配/);
});

test('rejects split target names that already belong to another object', { skip: !Service }, async () => {
  const service = createService({
    async listObjectCategories() { return []; },
    async findActiveObjectNameConflict(name) {
      return name === '业务零信任' ? { canonical_name: '现有业务零信任' } : null;
    },
  });
  service.objectSplitPreview = async () => ({
    object: { id: sourceId, canonical_name: '零信任', status: 'active' },
    plans: [
      { id: 'plan-62', plan_number: 62, object_category: '运维管理区' },
      { id: 'plan-37', plan_number: 37, object_category: '业务平台' },
    ],
  });
  await assert.rejects(service.saveObjectSplitDraft(sourceId, {
    groups: [
      { name: '运维零信任', category: '运维管理区', planIds: [ 'plan-62' ] },
      { name: '业务零信任', category: '业务平台', planIds: [ 'plan-37' ] },
    ],
  }, 'user-1'), /拆分目标名称已对应现有规范对象/);
});
