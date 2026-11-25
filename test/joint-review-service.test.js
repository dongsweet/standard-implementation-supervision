'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let Service;
try {
  Service = require('../app/service/jointReview');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function createService(repository) {
  const service = Object.create(Service.prototype);
  Object.defineProperty(service, 'repository', { value: repository });
  return service;
}

const definitionContext = {
  id: '00000000-0000-0000-0000-000000000001',
  plan_number: 295,
  object_name: '业务防火墙',
  object_category: '业务平台、识别结果记录、配置项参数设置规程等相关文档',
  check_layer: '管理层面',
  check_method: '证据材料核查',
  description: '检查配置管理文档，识别不必要端口并整改',
  steps: '核对配置和整改记录',
  frequency: '每月',
  access_mode: '现场',
  object_id: '00000000-0000-0000-0000-000000000002',
  master_object_name: '业务防火墙',
  master_category: '',
  centers: [ '云中心' ],
  standard_items: [ {
    id: '00000000-0000-0000-0000-000000000003',
    standardNumber: '31168-2023-10037',
    code: '10.1',
    title: '识别要求',
    content: '按照[赋值：云服务商定义的频率]，识别不必要或不安全的功能、端口、协议和服务；',
  } ],
  project_answers: [ {
    id: 'answer-1',
    projectId: '00000000-0000-0000-0000-000000000004',
    projectName: '多云统管',
    status: 'satisfied',
    applicability: 'applicable',
    clauseAssignment: '云服务商定义的频率：每月一次',
    assignmentDetails: [],
    complianceDescription: '每月识别并整改',
    actualEvidence: '配置管理审计报告',
  } ],
};

test('scans only the requested context and persists deterministic candidates', { skip: !Service }, async () => {
  let stored;
  const repository = {
    async listDefinitionContexts(scope) {
      assert.equal(scope.definitionId, definitionContext.id);
      return [ definitionContext ];
    },
    async listObjectContexts(scope) {
      return scope.objectId ? [] : [ {
        id: definitionContext.object_id,
        canonical_name: definitionContext.master_object_name,
        master_category: definitionContext.master_category,
        plan_categories: [
          '业务平台',
          definitionContext.object_category,
        ],
        plan_count: 25,
      } ];
    },
    async listCoverageContexts() {
      return [];
    },
    async upsertCandidates(candidates) {
      stored = candidates;
      return { inserted: candidates.length, updated: 0 };
    },
  };
  const result = await createService(repository).scan({ definitionId: definitionContext.id });
  assert.equal(result.candidateCount, 2);
  assert.ok(stored.some(item => item.reviewType === 'object_content'));
  assert.ok(stored.some(item => item.reviewType === 'category_consistency'));
  assert.ok(stored.every(item => item.fingerprint.length === 64));
  assert.ok(stored.every(item => item.contextHash.length === 64));
});

test('rejects invalid human decisions and requires notes for confirmed issues', { skip: !Service }, async () => {
  const repository = {
    async findById() {
      return { id: 'review-1' };
    },
  };
  const service = createService(repository);
  const context = {
    throw(status, message) {
      const error = new Error(message);
      error.status = status;
      throw error;
    },
  };
  Object.defineProperty(service, 'ctx', { value: context });
  await assert.rejects(service.saveHumanDecision('review-1', { decision: 'auto_fix' }, 'user-1'), /无效的人工复核结论/);
  await assert.rejects(service.saveHumanDecision('review-1', { decision: 'mismatch_confirmed' }, 'user-1'), /请填写复核备注/);
});

test('saves explicit human decisions without modifying source business records', { skip: !Service }, async () => {
  let saved;
  const repository = {
    async findById() {
      return { id: 'review-1' };
    },
    async saveHumanDecision(id, payload) {
      saved = { id, ...payload };
      return saved;
    },
  };
  const service = createService(repository);
  Object.defineProperty(service, 'ctx', { value: {} });
  const result = await service.saveHumanDecision('review-1', {
    decision: 'mismatch_confirmed',
    notes: '对象分类确实混入证据材料',
  }, 'user-1');
  assert.equal(result.decision, 'mismatch_confirmed');
  assert.equal(saved.notes, '对象分类确实混入证据材料');
  assert.equal(saved.reviewerId, 'user-1');
});
