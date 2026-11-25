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

test('loads the complete canonical object catalog for the workbench merge picker', { skip: !Service }, async () => {
  const calls = [];
  const service = createService({
    async listObjectWorkbench(query) {
      calls.push([ 'workbench', query ]);
      return { rows: [ { id: 'source', canonical_name: '《开发商安全管理规范》' } ], total: 1, page: 1, pageCount: 1 };
    },
    async listObjectCategories() {
      calls.push([ 'categories' ]);
      return [];
    },
    async listObjectPickerOptions() {
      calls.push([ 'options' ]);
      return [
        { id: 'source', canonical_name: '《开发商安全管理规范》', object_category: '管理制度' },
        { id: 'target', canonical_name: '云平台软件开发安全管理规范', object_category: '管理制度' },
      ];
    },
  });
  const result = await service.listCenterObjects();
  assert.deepEqual(calls.map(call => call[0]), [ 'workbench', 'categories', 'options' ]);
  assert.equal(result.objectOptions.length, 2);
  assert.equal(result.objectOptions[1].canonical_name, '云平台软件开发安全管理规范');
});

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

test('submits AI screening candidates in bounded batches and reports remaining progress', { skip: !Service }, async () => {
  const candidates = Array.from({ length: 5 }, (_, index) => ({
    id: `pair-${index + 1}`,
    center_name: '云中心',
    left_object_name: `对象A${index + 1}`,
    right_object_name: `对象B${index + 1}`,
    candidate_type: 'similar',
    ai: null,
    ai_status: 'pending',
    left: { plan_count: 1 },
    right: { plan_count: 1 },
  }));
  const createdJobs = [];
  const completedJobs = [];
  let submittedItems = [];
  const repository = {
    async createObjectAiJob({ centerName, leftObjectName, rightObjectName }) {
      const job = { id: `job-${createdJobs.length + 1}`, centerName, leftObjectName, rightObjectName };
      createdJobs.push(job);
      return job;
    },
    async completeObjectAiJob(id, response) {
      completedJobs.push({ id, response });
      return { id };
    },
    async failObjectAiJob() {
      throw new Error('unexpected failure');
    },
  };
  const service = createService(repository);
  service.listCenterObjectCandidates = async () => candidates;
  service.objectCandidateContext = async (centerName, leftObjectName, rightObjectName) => ({
    left: { plan_count: 1, check_methods: [ '测试方法' ] },
    right: { plan_count: 1, check_methods: [ '测试方法' ] },
    leftPlans: [ { id: `${leftObjectName}-plan`, check_method: '测试方法', description: leftObjectName } ],
    rightPlans: [ { id: `${rightObjectName}-plan`, check_method: '测试方法', description: rightObjectName } ],
  });
  Object.defineProperty(service, 'ctx', {
    value: {
      service: {
        systemSetting: { getAiConfig: async () => ({ model: 'test-model' }) },
        aiProvider: {
          async classifyCenterObjectPairs(items) {
            submittedItems = items;
            return {
              results: items.map(item => ({
                id: item.id,
                relation: 'similar_but_distinct',
                confidence: 0.9,
                differences: [ '测试' ],
                reason: '批量测试',
                recommendedCanonicalName: null,
              })),
              providerStatus: 200,
              durationMs: 10,
            };
          },
        },
      },
    },
  });
  const result = await service.aiScreenCenterObjectCandidates({ limit: 2, threshold: 0.6 });
  assert.equal(submittedItems.length, 2);
  assert.equal(createdJobs.length, 2);
  assert.equal(completedJobs.length, 2);
  assert.equal(result.totalCount, 5);
  assert.equal(result.submittedCount, 2);
  assert.equal(result.processedCount, 2);
  assert.equal(result.errorCount, 0);
  assert.equal(result.remainingCount, 3);
  assert.equal(result.done, false);
});

test('reports actionable AI connection errors for a failed object batch', { skip: !Service }, async () => {
  const repository = {
    async createObjectAiJob() {
      return { id: 'job-connection-failure' };
    },
    async failObjectAiJob(id, error) {
      assert.equal(id, 'job-connection-failure');
      return { id, error: error.message };
    },
  };
  const service = createService(repository);
  service.listCenterObjectCandidates = async () => [ {
    id: 'pair-network',
    center_name: '云中心',
    left_object_name: '对象A',
    right_object_name: '对象B',
    candidate_type: 'similar',
    ai: null,
    ai_status: 'pending',
  } ];
  service.objectCandidateContext = async () => ({
    left: { plan_count: 1, check_methods: [] },
    right: { plan_count: 1, check_methods: [] },
    leftPlans: [],
    rightPlans: [],
  });
  const failure = new Error('fetch failed');
  failure.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
  failure.baseUrl = 'https://ai.example.com/v1';
  Object.defineProperty(service, 'ctx', {
    value: {
      service: {
        systemSetting: { getAiConfig: async () => ({ model: 'test-model' }) },
        aiProvider: { async classifyCenterObjectPairs() { throw failure; } },
      },
    },
  });
  const result = await service.aiScreenCenterObjectCandidates({ limit: 4, threshold: 0.6 });
  assert.equal(result.processedCount, 0);
  assert.equal(result.errorCount, 1);
  assert.equal(result.errors[0].code, 'AI_CONNECT_TIMEOUT');
  assert.match(result.errors[0].message, /连接AI服务/);
});

test('filters object rows by AI duplicate, excluded, and pending categories', { skip: !Service }, async () => {
  const candidates = [
    { id: 'all', candidate_type: 'similar', ai: null, ai_status: 'pending' },
    { id: 'duplicate', candidate_type: 'similar', ai: { relation: 'duplicate' }, ai_status: 'completed' },
    { id: 'excluded', candidate_type: 'similar', ai: { relation: 'similar_but_distinct' }, ai_status: 'completed' },
    { id: 'pending', candidate_type: 'similar', ai: null, ai_status: 'pending' },
    { id: 'failed', candidate_type: 'similar', ai: null, ai_status: 'failed' },
  ];
  const service = createService({
    async listCenterObjectReviews() {
      return [];
    },
  });
  service.listCenterObjectCandidates = async () => candidates;
  const all = await service.listCenterObjectDedupe({ scanned: true, filter: 'all' });
  const duplicate = await service.listCenterObjectDedupe({ scanned: true, filter: 'ai_duplicate' });
  const excluded = await service.listCenterObjectDedupe({ scanned: true, filter: 'ai_excluded' });
  const pending = await service.listCenterObjectDedupe({ scanned: true, filter: 'ai_pending' });
  assert.deepEqual(all.candidates.map(item => item.id), [ 'all', 'duplicate', 'excluded', 'pending', 'failed' ]);
  assert.deepEqual(duplicate.candidates.map(item => item.id), [ 'duplicate' ]);
  assert.deepEqual(excluded.candidates.map(item => item.id), [ 'excluded' ]);
  assert.deepEqual(pending.candidates.map(item => item.id), [ 'all', 'pending', 'failed' ]);
  assert.equal(duplicate.filter, 'ai_duplicate');
  assert.equal(duplicate.summary.candidateCount, 5);
});

test('keeps all rule candidates available for manual review with optional AI annotations', { skip: !Service }, async () => {
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
  assert.equal(result.summary.aiDuplicateCount, 0);
  assert.equal(result.summary.excludedCount, 1);
  assert.equal(result.summary.pendingCount, 1);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates.some(candidate => candidate.left_object_name === '安全信息对内发布记录'), true);
  assert.equal(result.excludedCandidates[0].ai.relation, 'similar_but_distinct');
});
