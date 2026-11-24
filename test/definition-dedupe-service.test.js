'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let Service;
try {
  Service = require('../app/service/dedupe');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function createService(repository) {
  const service = Object.create(Service.prototype);
  Object.defineProperty(service, 'repository', { value: repository });
  return service;
}

const candidates = [
  {
    id: '00000000-0000-0000-0000-00000000000a',
    candidate_id: '00000000-0000-0000-0000-00000000000b',
    candidate_type: 'similar_candidate',
    similarity_score: 0.8,
    ai: null,
    ai_status: 'pending',
  },
  {
    id: '00000000-0000-0000-0000-00000000000c',
    candidate_id: '00000000-0000-0000-0000-00000000000d',
    candidate_type: 'similar_candidate',
    similarity_score: 0.9,
    ai: { relation: 'duplicate', confidence: 0.95 },
    ai_status: 'completed',
  },
  {
    id: '00000000-0000-0000-0000-00000000000e',
    candidate_id: '00000000-0000-0000-0000-00000000000f',
    candidate_type: 'similar_candidate',
    similarity_score: 0.7,
    ai: { relation: 'similar_but_distinct', confidence: 0.9 },
    ai_status: 'completed',
  },
  {
    id: '00000000-0000-0000-0000-000000000010',
    candidate_id: '00000000-0000-0000-0000-000000000011',
    candidate_type: 'similar_candidate',
    similarity_score: 0.6,
    ai: null,
    ai_status: 'failed',
  },
];

test('keeps check-plan candidates lazy until explicit rule scan', { skip: !Service }, async () => {
  const calls = [];
  const service = createService({
    async listDefinitionReviews() {
      calls.push('reviews');
      return [];
    },
    async listCandidates() {
      calls.push('candidates');
      return [];
    },
    async listDefinitionAiJobs() {
      calls.push('ai');
      return [];
    },
  });
  const result = await service.listDefinitionDedupe({ scanned: false });
  assert.equal(result.scanned, false);
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(calls, [ 'reviews' ]);
});

test('filters check-plan candidates by optional AI result categories', { skip: !Service }, async () => {
  const service = createService({});
  service.listReviews = async () => [];
  service.listCandidates = async () => candidates;
  const all = await service.listDefinitionDedupe({ scanned: true, threshold: 0.35, filter: 'all' });
  const duplicate = await service.listDefinitionDedupe({ scanned: true, threshold: 0.35, filter: 'ai_duplicate' });
  const excluded = await service.listDefinitionDedupe({ scanned: true, threshold: 0.35, filter: 'ai_excluded' });
  const pending = await service.listDefinitionDedupe({ scanned: true, threshold: 0.35, filter: 'ai_pending' });
  assert.equal(all.summary.candidateCount, 4);
  assert.equal(duplicate.candidates.length, 1);
  assert.equal(excluded.candidates.length, 1);
  assert.equal(pending.candidates.length, 2);
  assert.equal(all.summary.aiDuplicateCount, 1);
  assert.equal(all.summary.aiExcludedCount, 1);
  assert.equal(all.summary.aiPendingCount, 2);
});

test('submits check-plan AI screening in bounded batches', { skip: !Service }, async () => {
  const repository = {
    async findById(id) {
      return {
        id,
        object_name: '同一对象',
        object_category: '技术',
        check_layer: '配置',
        check_method: '证据材料核查',
        description: `描述 ${id}`,
        steps: '步骤',
        frequency: '年度',
        access_mode: '现场',
        centers: [ '云中心' ],
      };
    },
    async createAiJob({ leftId, rightId }) {
      return { id: `job-${leftId.slice(-1)}-${rightId.slice(-1)}` };
    },
    async completeAiJob() {
      return {};
    },
    async failAiJob() {
      throw new Error('unexpected failure');
    },
  };
  const service = createService(repository);
  service.listCandidates = async () => candidates;
  let submitted = 0;
  Object.defineProperty(service, 'ctx', {
    value: {
      service: {
        systemSetting: { getAiConfig: async () => ({ model: 'test-model' }) },
        aiProvider: {
          async classifyDefinitionPairs(items) {
            submitted = items.length;
            return {
              results: items.map(item => ({
                id: item.id,
                relation: 'duplicate',
                confidence: 0.9,
                differences: [],
                reason: '批量测试',
                recommendedCanonicalId: item.left.id,
              })),
              providerStatus: 200,
              durationMs: 10,
            };
          },
        },
      },
    },
  });
  const result = await service.aiScreenDefinitionCandidates({ limit: 2, threshold: 0.35 });
  assert.equal(submitted, 2);
  assert.equal(result.totalCount, 2);
  assert.equal(result.submittedCount, 2);
  assert.equal(result.processedCount, 2);
  assert.equal(result.errorCount, 0);
  assert.equal(result.done, true);
});
