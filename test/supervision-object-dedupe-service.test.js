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
  return service;
}

test('does not scan object candidates until explicitly requested', { skip: !Service }, async () => {
  const calls = [];
  const service = createService({
    async listCenterObjectReviews() {
      calls.push('reviews');
      return [];
    },
    async listCenterObjectEntries() {
      calls.push('entries');
      return [];
    },
    async listObjectAiJobs() {
      calls.push('ai');
      return [];
    },
  });
  const result = await service.listCenterObjectDedupe({ scanned: false });
  assert.equal(result.scanned, false);
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(calls, [ 'reviews' ]);
});

test('keeps similar candidates pending until AI explicitly returns duplicate', { skip: !Service }, async () => {
  const baseEntries = [
    { center_name: '云中心', object_name: '安全信息对内发布记录', plan_count: 1 },
    { center_name: '云中心', object_name: '安全信息对外发布记录', plan_count: 1 },
    { center_name: '总部', object_name: '《采购合同或协议》', plan_count: 1 },
    { center_name: '总部', object_name: '采购合同或协议', plan_count: 1 },
  ];
  const service = createService({
    async listCenterObjectReviews() {
      return [];
    },
    async listCenterObjectEntries() {
      return baseEntries;
    },
    async listObjectAiJobs() {
      return [ {
        center_name: '云中心',
        left_object_name: '安全信息对内发布记录',
        right_object_name: '安全信息对外发布记录',
        status: 'completed',
        result: { relation: 'similar_but_distinct', confidence: 0.97, reason: '方向不同' },
      } ];
    },
  });
  const result = await service.listCenterObjectDedupe({ scanned: true, threshold: 0.6 });
  assert.equal(result.summary.actionableCount, 1);
  assert.equal(result.summary.excludedCount, 1);
  assert.equal(result.summary.pendingCount, 0);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].candidate_type, 'exact');
  assert.equal(result.excludedCandidates[0].ai.relation, 'similar_but_distinct');
});
