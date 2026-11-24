'use strict';

const Service = require('egg').Service;
const crypto = require('node:crypto');
const { normalizeDefinition } = require('../lib/dedupe');
const { friendlyAiError } = require('../lib/aiProvider');
const {
  buildObjectCandidates,
  objectCandidate,
  pairKey,
  partitionSemanticCandidates,
} = require('../lib/centerObjectDedupe');
const { DEFAULT_SUPERVISION_METHODS, joinSupervisionMethods, splitSupervisionMethods } = require('../lib/supervisionMethods');
const { DEFAULT_SUPERVISION_CENTERS, splitSupervisionCenters } = require('../lib/supervisionCenters');
const Repository = require('../repository/supervisionDefinition');

// PostgreSQL accepts UUIDs with any version/variant bits; validate the shape only.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class SupervisionDefinitionService extends Service {
  get repository() {
    return new Repository(this.ctx.app.db);
  }

  async list(query = {}) {
    const search = String(query.search || '').trim().slice(0, 100);
    const status = String(query.status || '').trim();
    const priority = String(query.priority || '').trim();
    const checkMethod = String(query.checkMethod || '').trim().slice(0, 100);
    const center = String(query.center || '').trim();
    const allowedStatuses = new Set([ '', 'active', 'merged' ]);
    const allowedPriorities = new Set([ '', '重点项', '非重点项', '未指定' ]);
    if (!allowedStatuses.has(status)) this.ctx.throw(400, '无效的方案状态');
    if (!allowedPriorities.has(priority)) this.ctx.throw(400, '无效的重点项筛选');
    const pageSize = 20;
    const requestedPage = Number.parseInt(query.page, 10);
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const [ definitionResult, standardItems, methodRows, centers ] = await Promise.all([
      this.repository.listDefinitions({ search, status, priority, checkMethod, center, page, pageSize }),
      this.repository.listStandardItems(),
      this.repository.listDefinitionMethods(),
      this.repository.listDefinitionCenters(),
    ]);
    const checkMethodOptions = new Set(DEFAULT_SUPERVISION_METHODS);
    for (const methodValue of methodRows) {
      splitSupervisionMethods(methodValue).forEach(method => checkMethodOptions.add(method));
    }
    return {
      definitions: definitionResult.rows,
      standardItems,
      checkMethodOptions: [ ...checkMethodOptions ].sort((left, right) => left.localeCompare(right, 'zh-CN')),
      centers,
      centerOptions: DEFAULT_SUPERVISION_CENTERS,
      total: definitionResult.total,
      page: definitionResult.page,
      pageSize,
      pageCount: definitionResult.pageCount,
      search,
      status,
      priority,
      checkMethod,
      center,
    };
  }

  async listCenterObjects(query = {}) {
    const center = String(query.center || '').trim();
    const search = String(query.search || '').trim().slice(0, 100);
    if (center && !DEFAULT_SUPERVISION_CENTERS.includes(center)) this.ctx.throw(400, '无效的检查中心筛选');
    const pageSize = 20;
    const requestedPage = Number.parseInt(query.page, 10);
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const result = await this.repository.listCenterObjects({ center, search, page, pageSize });
    return {
      center,
      search,
      centerOptions: DEFAULT_SUPERVISION_CENTERS,
      centerObjects: result.rows,
      total: result.total,
      page: result.page,
      pageSize,
      pageCount: result.pageCount,
    };
  }

  async listCenterObjectCandidates({ threshold = 0.6 } = {}) {
    const [ entries, reviews, aiJobs ] = await Promise.all([
      this.repository.listCenterObjectEntries(),
      this.repository.listCenterObjectReviews(),
      this.repository.listObjectAiJobs(),
    ]);
    const aiByPair = new Map(aiJobs.map(job => [
      pairKey(job.center_name, job.left_object_name, job.right_object_name),
      job,
    ]));
    return buildObjectCandidates(entries, reviews, threshold).map(candidate => {
      const aiJob = aiByPair.get(pairKey(
        candidate.center_name,
        candidate.left_object_name,
        candidate.right_object_name
      ));
      const ai = aiJob?.status === 'completed' ? aiJob.result : null;
      return {
        ...candidate,
        id: crypto.createHash('sha256')
          .update(JSON.stringify([
            candidate.center_name,
            ...[ candidate.left_object_name, candidate.right_object_name ].sort(),
          ]))
          .digest('hex'),
        ai,
        ai_status: aiJob?.status || 'pending',
        ai_error: aiJob?.status === 'failed' ? aiJob.error_message : null,
      };
    });
  }

  async aiScreenCenterObjectCandidates({ limit = 4, threshold = 0.6 } = {}) {
    const candidates = await this.listCenterObjectCandidates({ threshold });
    const pending = candidates.filter(candidate =>
      candidate.candidate_type === 'similar' && !candidate.ai
    );
    const batchSize = Math.max(1, Math.min(Number(limit) || 4, 8));
    const batch = pending.slice(0, batchSize);
    if (!batch.length) {
      return {
        totalCount: 0,
        submittedCount: 0,
        processedCount: 0,
        errorCount: 0,
        remainingCount: 0,
        done: true,
        results: [],
        errors: [],
      };
    }
    const aiConfig = await this.ctx.service.systemSetting.getAiConfig({ includeKey: false });
    const modelName = aiConfig.model || 'unconfigured';
    const promptVersion = 'center-object-dedupe-batch-v1';
    const prepared = [];
    const preparationErrors = [];
    for (const candidate of batch) {
      try {
        const context = await this.objectCandidateContext(
          candidate.center_name,
          candidate.left_object_name,
          candidate.right_object_name
        );
        const inputHash = crypto.createHash('sha256').update(JSON.stringify([
          candidate.center_name,
          [ candidate.left_object_name, candidate.right_object_name ].sort(),
          context.leftPlans.map(plan => [ plan.id, plan.check_method, plan.description ]),
          context.rightPlans.map(plan => [ plan.id, plan.check_method, plan.description ]),
          modelName,
          promptVersion,
        ])).digest('hex');
        const job = await this.repository.createObjectAiJob({
          centerName: candidate.center_name,
          leftObjectName: candidate.left_object_name,
          rightObjectName: candidate.right_object_name,
          inputHash,
          algorithmVersion: 'object-normalized-trigram-v1',
          promptVersion,
          modelName,
        });
        const compactPlans = plans => plans.slice(0, 3).map(plan => ({
          description: String(plan.description || '').slice(0, 500),
          steps: String(plan.steps || '').slice(0, 300),
          frequency: String(plan.frequency || '').slice(0, 100),
          accessMode: String(plan.access_mode || '').slice(0, 50),
        }));
        prepared.push({
          candidate,
          job,
          payload: {
            id: candidate.id,
            centerName: candidate.center_name,
            left: {
              name: candidate.left_object_name,
              planCount: context.left.plan_count,
              methods: context.left.check_methods || [],
              plans: compactPlans(context.leftPlans),
            },
            right: {
              name: candidate.right_object_name,
              planCount: context.right.plan_count,
              methods: context.right.check_methods || [],
              plans: compactPlans(context.rightPlans),
            },
          },
        });
      } catch (error) {
        preparationErrors.push({
          centerName: candidate.center_name,
          leftObjectName: candidate.left_object_name,
          rightObjectName: candidate.right_object_name,
          message: error.message,
        });
      }
    }

    let aiResponse;
    if (prepared.length) {
      try {
        aiResponse = await this.ctx.service.aiProvider.classifyCenterObjectPairs(
          prepared.map(item => item.payload)
        );
      } catch (error) {
        const friendly = friendlyAiError(error, error.baseUrl);
        for (const item of prepared) {
          await this.repository.failObjectAiJob(item.job.id, error);
          preparationErrors.push({
            centerName: item.candidate.center_name,
            leftObjectName: item.candidate.left_object_name,
            rightObjectName: item.candidate.right_object_name,
            message: friendly.message,
            code: friendly.code,
          });
        }
      }
    }

    const resultById = new Map((aiResponse?.results || []).map(result => [ String(result.id), result ]));
    const results = [];
    const errors = [ ...preparationErrors ];
    for (const item of prepared) {
      const result = resultById.get(String(item.payload.id));
      if (!result) {
        if (aiResponse) {
          const error = new Error('AI 未返回该对象候选的判断结果');
          await this.repository.failObjectAiJob(item.job.id, error);
          errors.push({
            centerName: item.candidate.center_name,
            leftObjectName: item.candidate.left_object_name,
            rightObjectName: item.candidate.right_object_name,
            message: error.message,
          });
        }
        continue;
      }
      await this.repository.completeObjectAiJob(item.job.id, {
        result,
        providerStatus: aiResponse.providerStatus,
        durationMs: aiResponse.durationMs,
      });
      results.push({
        centerName: item.candidate.center_name,
        leftObjectName: item.candidate.left_object_name,
        rightObjectName: item.candidate.right_object_name,
        relation: result.relation,
        confidence: result.confidence,
      });
    }
    return {
      totalCount: pending.length,
      submittedCount: batch.length,
      processedCount: results.length,
      errorCount: errors.length,
      remainingCount: Math.max(0, pending.length - batch.length),
      done: pending.length <= batch.length,
      results,
      errors,
    };
  }

  async listCenterObjectReviews() {
    return this.repository.listCenterObjectReviews();
  }

  async listCenterObjectDedupe({ threshold = null, scanned = false } = {}) {
    const reviews = await this.repository.listCenterObjectReviews();
    if (!scanned) {
      return {
        threshold,
        scanned: false,
        candidates: [],
        excludedCandidates: [],
        pendingCandidates: [],
        failedCandidates: [],
        summary: {
          candidateCount: 0,
          aiDuplicateCount: 0,
          pendingCount: 0,
          excludedCount: 0,
          failedCount: 0,
          exactCount: 0,
          similarCount: 0,
          reviewedCount: reviews.length,
          mergedCount: reviews.filter(review => review.decision === 'merged').length,
        },
      };
    }
    const candidates = await this.listCenterObjectCandidates({ threshold });
    const partitioned = partitionSemanticCandidates(candidates);
    return {
      threshold,
      scanned: true,
      candidates: partitioned.ruleCandidates,
      excludedCandidates: partitioned.aiExcluded,
      pendingCandidates: partitioned.aiPending,
      failedCandidates: partitioned.aiFailed,
      reviews,
      summary: {
        candidateCount: candidates.length,
        aiDuplicateCount: partitioned.aiDuplicate.length,
        pendingCount: partitioned.aiPending.length,
        excludedCount: partitioned.aiExcluded.length,
        failedCount: partitioned.aiFailed.length,
        exactCount: candidates.filter(candidate => candidate.candidate_type === 'exact').length,
        similarCount: candidates.filter(candidate => candidate.candidate_type === 'similar').length,
        reviewedCount: reviews.length,
        mergedCount: reviews.filter(review => review.decision === 'merged').length,
      },
    };
  }

  async objectCandidateContext(centerName, leftObjectName, rightObjectName) {
    const left = await this.repository.centerObjectEntry(centerName, leftObjectName);
    const right = await this.repository.centerObjectEntry(centerName, rightObjectName);
    if (!left || !right || !objectCandidate(leftObjectName, rightObjectName, 0)) {
      this.ctx.throw(409, '对象去重候选已发生变化，请刷新后重试');
    }
    const [ leftPlans, rightPlans ] = await Promise.all([
      this.repository.centerObjectPlans(centerName, leftObjectName),
      this.repository.centerObjectPlans(centerName, rightObjectName),
    ]);
    return { left, right, leftPlans, rightPlans };
  }

  async aiReviewCenterObjectCandidate({ centerName, leftObjectName, rightObjectName }) {
    const context = await this.objectCandidateContext(centerName, leftObjectName, rightObjectName);
    const aiConfig = await this.ctx.service.systemSetting.getAiConfig({ includeKey: false });
    const modelName = aiConfig.model || 'unconfigured';
    const promptVersion = 'center-object-dedupe-v1';
    const inputHash = crypto.createHash('sha256').update(JSON.stringify([
      centerName,
      [ leftObjectName, rightObjectName ].sort(),
      context.leftPlans.map(plan => [ plan.id, plan.check_method, plan.description ]),
      context.rightPlans.map(plan => [ plan.id, plan.check_method, plan.description ]),
      modelName,
      promptVersion,
    ])).digest('hex');
    const existing = await this.repository.findObjectAiJob(inputHash, modelName, promptVersion);
    if (existing?.result) return existing;
    const job = await this.repository.createObjectAiJob({
      centerName,
      leftObjectName,
      rightObjectName,
      inputHash,
      algorithmVersion: 'object-normalized-trigram-v1',
      promptVersion,
      modelName,
    });
    try {
      const result = await this.ctx.service.aiProvider.classifyCenterObjectPair({
        centerName,
        left: {
          name: leftObjectName,
          planCount: context.left.plan_count,
          methods: context.left.check_methods,
          plans: context.leftPlans.map(plan => ({
            description: plan.description,
            steps: plan.steps,
            frequency: plan.frequency,
            accessMode: plan.access_mode,
          })),
        },
        right: {
          name: rightObjectName,
          planCount: context.right.plan_count,
          methods: context.right.check_methods,
          plans: context.rightPlans.map(plan => ({
            description: plan.description,
            steps: plan.steps,
            frequency: plan.frequency,
            accessMode: plan.access_mode,
          })),
        },
      });
      if (result.result.recommendedCanonicalName
        && ![ leftObjectName, rightObjectName ].includes(result.result.recommendedCanonicalName)) {
        result.result.recommendedCanonicalName = null;
      }
      return this.repository.completeObjectAiJob(job.id, result);
    } catch (error) {
      await this.repository.failObjectAiJob(job.id, error);
      throw error;
    }
  }

  async reviewCenterObjectCandidate(payload, reviewerId) {
    const centerName = String(payload.centerName || '').trim();
    const leftObjectName = String(payload.leftObjectName || '').trim();
    const rightObjectName = String(payload.rightObjectName || '').trim();
    const decision = String(payload.decision || '').trim();
    const canonicalObjectName = String(payload.canonicalObjectName || '').trim();
    if (!DEFAULT_SUPERVISION_CENTERS.includes(centerName)) this.ctx.throw(400, '无效的检查中心');
    if (!leftObjectName || !rightObjectName || leftObjectName === rightObjectName) this.ctx.throw(400, '请提供两个不同的检查对象');
    if (![ 'merged', 'distinct', 'uncertain' ].includes(decision)) this.ctx.throw(400, '无效的对象复核结论');
    await this.objectCandidateContext(centerName, leftObjectName, rightObjectName);
    if (decision === 'merged' && ![ leftObjectName, rightObjectName ].includes(canonicalObjectName)) {
      this.ctx.throw(400, '合并时必须选择一个保留对象');
    }
    try {
      return await this.repository.reviewCenterObject({
        centerName,
        leftObjectName,
        rightObjectName,
        decision,
        canonicalObjectName: decision === 'merged' ? canonicalObjectName : null,
        notes: String(payload.notes || '').trim() || null,
        reviewerId,
      });
    } catch (error) {
      if ([ 'OBJECT_DEDUPE_CANDIDATE_CHANGED', 'OBJECT_DEDUPE_INVALID_CANONICAL', 'OBJECT_DEDUPE_CROSS_CENTER' ].includes(error.code)) {
        this.ctx.throw(409, error.message);
      }
      throw error;
    }
  }

  normalize(payload) {
    const checkMethod = joinSupervisionMethods([
      payload.checkMethods,
      payload.checkMethod,
      payload.additionalCheckMethods,
    ]);
    const fields = {
      object_name: String(payload.objectName || '').trim(),
      scope: String(payload.scope || '').trim(),
      centers: splitSupervisionCenters(payload.centers),
      recognized_object: payload.recognizedObject === '' || payload.recognizedObject === undefined
        ? null
        : payload.recognizedObject === true || payload.recognizedObject === 'true' || payload.recognizedObject === '是',
      object_category: String(payload.objectCategory || '').trim(),
      check_layer: String(payload.checkLayer || '').trim(),
      check_method: checkMethod,
      description: String(payload.description || '').trim(),
      steps: String(payload.steps || '').trim(),
      frequency: String(payload.frequency || '').trim(),
      access_mode: String(payload.accessMode || '').trim(),
      priority: String(payload.priority || '').trim(),
      reference_result: String(payload.referenceResult || '').trim(),
      reference_materials: String(payload.referenceMaterials || '').trim(),
    };
    if (payload.recognizedObject && ![ true, 'true', 'false', '是', '否' ].includes(payload.recognizedObject)) {
      this.ctx.throw(400, '是否公认对象只能填写“是”或“否”');
    }
    if (fields.priority && ![ '重点项', '非重点项' ].includes(fields.priority)) this.ctx.throw(400, '重点项只能填写“重点项”或“非重点项”');
    if (!fields.object_name || !fields.check_method || !fields.description) this.ctx.throw(400, '检查对象、检查方法和检查描述不能为空');
    if (fields.object_name.length > 500 || fields.scope.length > 200 || fields.object_category.length > 200 || fields.check_layer.length > 200
      || fields.check_method.length > 2000 || fields.description.length > 5000 || fields.frequency.length > 100
      || fields.access_mode.length > 50 || fields.priority.length > 50) this.ctx.throw(400, '监督定义字段长度超出限制');
    if (fields.centers.some(center => !DEFAULT_SUPERVISION_CENTERS.includes(center))) this.ctx.throw(400, '适用检查中心只能选择云中心、统一运维中心或总部');
    if (!fields.centers.length) this.ctx.throw(400, '请至少选择一个适用检查中心');
    const itemIds = Array.isArray(payload.standardItemIds) ? payload.standardItemIds : [ payload.standardItemIds ];
    const standardItemIds = [ ...new Set(itemIds.map(item => String(item || '').trim()).filter(Boolean)) ];
    if (!standardItemIds.length) this.ctx.throw(400, '请至少关联一个标准项');
    if (standardItemIds.some(item => !UUID_RE.test(item))) this.ctx.throw(400, '标准项编号格式无效');
    return {
      fields: {
        objectName: fields.object_name,
        scope: fields.scope,
        centers: fields.centers,
        recognizedObject: fields.recognized_object,
        objectCategory: fields.object_category,
        checkLayer: fields.check_layer,
        checkMethod: fields.check_method,
        description: fields.description,
        steps: fields.steps,
        frequency: fields.frequency,
        accessMode: fields.access_mode,
        priority: fields.priority,
        referenceResult: fields.reference_result,
        referenceMaterials: fields.reference_materials,
        normalizedHash: normalizeDefinition(fields).normalizedHash,
      },
      standardItemIds,
    };
  }

  async create(payload, actorId) {
    const normalized = this.normalize(payload);
    try {
      return await this.repository.create(normalized, actorId);
    } catch (error) {
      if (error.code === 'INVALID_STANDARD_ITEMS') this.ctx.throw(400, error.message);
      throw error;
    }
  }

  async update(id, payload, actorId) {
    if (!UUID_RE.test(String(id || ''))) this.ctx.throw(400, '监督定义编号格式无效');
    let result;
    try {
      result = await this.repository.update(id, this.normalize(payload), actorId);
    } catch (error) {
      if (error.code === 'INVALID_STANDARD_ITEMS') this.ctx.throw(400, error.message);
      throw error;
    }
    if (!result) this.ctx.throw(404, '监督定义不存在或已归并');
    return result;
  }
}

module.exports = SupervisionDefinitionService;
