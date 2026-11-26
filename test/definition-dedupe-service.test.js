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

test('loads both candidate plans and editor options for a template merge', { skip: !Service }, async () => {
  const service = createService({
    async findMergeEditorOptions(ids) {
      assert.deepEqual(ids, [ 'left-id', 'right-id' ]);
      return [
        { id: 'left-id', plan_number: 1, object_name: '对象', check_method: '证据材料核查', centers: [ '云中心' ], standard_items: [] },
        { id: 'right-id', plan_number: 2, object_name: '对象', check_method: '访谈', centers: [ '总部' ], standard_items: [] },
      ];
    },
  });
  Object.defineProperty(service, 'ctx', {
    value: {
      app: {
        db: {
          query: async () => ({ rowCount: 1, rows: [ {} ] }),
        },
      },
    },
  });
  const result = await service.mergeEditorOptions('left-id', 'right-id');
  assert.equal(result.definitions.length, 2);
  assert.ok(result.checkMethodOptions.includes('证据材料核查'));
  assert.ok(result.checkMethodOptions.includes('访谈'));
  assert.deepEqual(result.centerOptions, [ '云中心', '统一运维中心', '总部' ]);
});

test('saves the edited template fields before merging the other plan', { skip: !Service }, async () => {
  const statements = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      statements.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: 0 };
      if (statement.startsWith('INSERT INTO supervision_definition_reviews')) return { rows: [ { id: 'review-1' } ], rowCount: 1 };
      if (statement.startsWith('SELECT id, frequency, steps')) {
        return {
          rows: [
            { id: 'left-id', status: 'active' },
            { id: 'right-id', status: 'active' },
          ],
          rowCount: 2,
        };
      }
      if (statement === 'SELECT id FROM standard_items WHERE id = ANY($1::uuid[])') return { rows: [], rowCount: 2 };
      if (statement.startsWith('UPDATE supervision_definitions SET object_name')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('UPDATE supervision_definitions SET status')) return { rows: [ { id: 'right-id' } ], rowCount: 1 };
      if (statement.startsWith('DELETE FROM supervision_definition_standard_items')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('DELETE FROM supervision_definition_centers')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_definition_standard_items')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO supervision_definition_centers')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  let candidateCheck = false;
  const service = createService({
    async ensureCanonicalObject() {
      return 'canonical-object-id';
    },
  });
  Object.defineProperty(service, 'ctx', {
    value: {
      app: {
        db: {
          async query(sql) {
            if (!sql.includes('supervision_definition_candidates')) throw new Error('Unexpected candidate query');
            candidateCheck = true;
            return { rowCount: 1, rows: [ {} ] };
          },
          async connect() {
            return client;
          },
        },
      },
      service: {
        supervisionDefinition: {
          normalize(payload) {
            assert.equal(payload.objectName, '编辑后的对象');
            return {
              fields: {
                objectName: payload.objectName,
                scope: '',
                recognizedObject: true,
                objectCategory: '运维管理区',
                checkLayer: '技术层面',
                checkMethod: '证据材料核查,访谈',
                description: '编辑后的描述',
                steps: '编辑后的步骤',
                frequency: '每季度',
                accessMode: '现场',
                priority: '重点项',
                referenceResult: '',
                referenceMaterials: '',
                normalizedHash: 'hash',
                centers: [ '云中心' ],
              },
              standardItemIds: [ 'item-1', 'item-2' ],
            };
          },
        },
      },
      throw(status, message) {
        throw Object.assign(new Error(message), { status });
      },
    },
  });
  await service.review({
    leftId: 'left-id',
    rightId: 'right-id',
    decision: 'duplicate',
    canonicalId: 'right-id',
    reviewerId: 'user-1',
    editedDefinition: { objectName: '编辑后的对象' },
  });
  assert.equal(candidateCheck, true);
  const fieldUpdate = statements.find(item => item.statement.startsWith('UPDATE supervision_definitions SET object_name'));
  assert.ok(fieldUpdate);
  assert.equal(fieldUpdate.values[1], '编辑后的对象');
  const fieldUpdateIndex = statements.indexOf(fieldUpdate);
  const mergeUpdateIndex = statements.findIndex(item => item.statement.startsWith('UPDATE supervision_definitions SET status'));
  assert.ok(fieldUpdateIndex < mergeUpdateIndex);
  assert.ok(statements.some(item => item.statement.startsWith('INSERT INTO audit_logs')
    && item.values[2].includes('"edited":true')));
  assert.ok(statements.some(item => item.statement === 'COMMIT'));
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
