'use strict';

const Service = require('egg').Service;
const crypto = require('node:crypto');
const { definitionConflicts, normalizeDefinition, scoreDefinition, normalizeText } = require('../lib/dedupe');
const { friendlyAiError } = require('../lib/aiProvider');
const { DEFAULT_SUPERVISION_METHODS, splitSupervisionMethods } = require('../lib/supervisionMethods');
const { DEFAULT_SUPERVISION_CENTERS } = require('../lib/supervisionCenters');
const SupervisionDefinitionRepository = require('../repository/supervisionDefinition');

function definitionPairKey(leftId, rightId) {
  return [ String(leftId), String(rightId) ].sort().join(':');
}

class DedupeService extends Service {
  get repository() {
    return new SupervisionDefinitionRepository(this.ctx.app.db);
  }

  definitionFingerprint(definition) {
    return JSON.stringify([
      definition.id,
      normalizeDefinition(definition).normalizedHash,
      definition.scope,
      definition.centers || [],
      definition.recognized_object,
      definition.priority,
      normalizeText(definition.access_mode),
      normalizeText(definition.reference_result),
      normalizeText(definition.reference_materials),
    ]);
  }

  async listCandidates({ threshold = 0.6, limit = 1000 } = {}) {
    const [ candidates, aiJobs ] = await Promise.all([
      this.repository.listCandidates({ threshold, limit }),
      this.repository.listDefinitionAiJobs(),
    ]);
    const aiByPair = new Map(aiJobs.map(job => [
      definitionPairKey(job.left_definition_id, job.right_definition_id),
      job,
    ]));
    return candidates.map(candidate => {
      const aiJob = aiByPair.get(definitionPairKey(candidate.id, candidate.candidate_id));
      return {
        ...candidate,
        ai: aiJob?.status === 'completed' ? aiJob.result : null,
        ai_status: aiJob?.status || 'pending',
        ai_error: aiJob?.status === 'failed' ? aiJob.error_message : null,
      };
    });
  }

  async listReviews() {
    return this.repository.listDefinitionReviews();
  }

  async mergeEditorOptions(leftId, rightId) {
    if (!leftId || !rightId || leftId === rightId) this.ctx.throw(400, '请提供两条不同的检查方案');
    const candidate = await this.ctx.app.db.query(`
      SELECT 1 FROM supervision_definition_candidates
      WHERE (id = $1 AND candidate_id = $2) OR (id = $2 AND candidate_id = $1)
      LIMIT 1`, [ leftId, rightId ]);
    if (!candidate.rowCount) this.ctx.throw(400, '仅可编辑规则层生成的候选检查方案');
    const definitions = await this.repository.findMergeEditorOptions([ leftId, rightId ]);
    if (definitions.length !== 2) this.ctx.throw(409, '候选检查方案已发生变化，请刷新后重试');
    const methodOptions = new Set(DEFAULT_SUPERVISION_METHODS);
    definitions.forEach(definition => {
      splitSupervisionMethods(definition.check_method).forEach(method => methodOptions.add(method));
    });
    return {
      definitions,
      centerOptions: DEFAULT_SUPERVISION_CENTERS,
      checkMethodOptions: [ ...methodOptions ].sort((left, right) => left.localeCompare(right, 'zh-CN')),
    };
  }

  async listDefinitionDedupe({ threshold = null, scanned = false, filter = 'all' } = {}) {
    const allowedFilters = new Set([ 'all', 'ai_duplicate', 'ai_excluded', 'ai_pending' ]);
    const activeFilter = allowedFilters.has(filter) ? filter : 'all';
    const reviews = await this.listReviews();
    if (!scanned) {
      return {
        threshold,
        scanned: false,
        filter: 'all',
        candidates: [],
        reviews,
        summary: {
          candidateCount: 0,
          aiDuplicateCount: 0,
          aiExcludedCount: 0,
          aiPendingCount: 0,
          reviewedCount: reviews.length,
        },
      };
    }
    const candidates = await this.listCandidates({ threshold });
    const excluded = candidate => [ 'similar_but_distinct', 'unrelated' ].includes(candidate.ai?.relation);
    const pending = candidate => !candidate.ai || candidate.ai_status === 'failed';
    const filtered = {
      all: candidates,
      ai_duplicate: candidates.filter(candidate => candidate.ai?.relation === 'duplicate'),
      ai_excluded: candidates.filter(excluded),
      ai_pending: candidates.filter(pending),
    }[activeFilter];
    return {
      threshold,
      scanned: true,
      filter: activeFilter,
      candidates: filtered,
      reviews,
      summary: {
        candidateCount: candidates.length,
        aiDuplicateCount: candidates.filter(candidate => candidate.ai?.relation === 'duplicate').length,
        aiExcludedCount: candidates.filter(excluded).length,
        aiPendingCount: candidates.filter(pending).length,
        reviewedCount: reviews.length,
      },
    };
  }

  async aiScreenDefinitionCandidates({ limit = 4, threshold = 0.6 } = {}) {
    const candidates = await this.listCandidates({ threshold });
    const pending = candidates.filter(candidate => !candidate.ai || candidate.ai_status === 'failed');
    const batch = pending.slice(0, Math.max(1, Math.min(Number(limit) || 4, 8)));
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
    const promptVersion = 'dedupe-batch-v1';
    const prepared = [];
    const errors = [];
    for (const candidate of batch) {
      try {
        const [ left, right ] = await Promise.all([
          this.repository.findById(candidate.id),
          this.repository.findById(candidate.candidate_id),
        ]);
        if (!left || !right) throw new Error('检查方案已发生变化，请刷新后重试');
        const inputHash = crypto.createHash('sha256')
          .update(JSON.stringify([ this.definitionFingerprint(left), this.definitionFingerprint(right) ].sort()))
          .digest('hex');
        const job = await this.repository.createAiJob({
          leftId: left.id,
          rightId: right.id,
          inputHash,
          algorithmVersion: 'trigram-weighted-v1',
          promptVersion,
          modelName,
        });
        prepared.push({ candidate, left, right, job });
      } catch (error) {
        errors.push({
          leftId: candidate.id,
          rightId: candidate.candidate_id,
          message: error.message,
        });
      }
    }
    let response;
    if (prepared.length) {
      try {
        response = await this.ctx.service.aiProvider.classifyDefinitionPairs(prepared.map(item => ({
          id: definitionPairKey(item.left.id, item.right.id),
          left: item.left,
          right: item.right,
        })));
      } catch (error) {
        const friendly = friendlyAiError(error, error.baseUrl);
        for (const item of prepared) {
          await this.repository.failAiJob(item.job.id, error);
          errors.push({
            leftId: item.left.id,
            rightId: item.right.id,
            message: friendly.message,
            code: friendly.code,
          });
        }
      }
    }
    const resultById = new Map((response?.results || []).map(result => [ String(result.id), result ]));
    const results = [];
    for (const item of prepared) {
      const result = resultById.get(definitionPairKey(item.left.id, item.right.id));
      if (!result) {
        if (response) {
          const error = new Error('AI 未返回该检查方案候选的判断结果');
          await this.repository.failAiJob(item.job.id, error);
          errors.push({ leftId: item.left.id, rightId: item.right.id, message: error.message });
        }
        continue;
      }
      await this.repository.completeAiJob(item.job.id, {
        result,
        providerStatus: response.providerStatus,
        durationMs: response.durationMs,
      });
      results.push({
        leftId: item.left.id,
        rightId: item.right.id,
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

  async aiReview({ leftId, rightId }) {
    const repository = new SupervisionDefinitionRepository(this.ctx.app.db);
    const left = await repository.findById(leftId);
    const right = await repository.findById(rightId);
    if (!left || !right) this.ctx.throw(404, '监督定义不存在');
    if (leftId === rightId) this.ctx.throw(400, '请提供两条不同的监督定义');
    const candidate = await this.ctx.app.db.query(`
      SELECT 1 FROM supervision_definition_candidates
      WHERE (id = $1 AND candidate_id = $2) OR (id = $2 AND candidate_id = $1)
      LIMIT 1`, [ leftId, rightId ]);
    if (!candidate.rowCount) this.ctx.throw(400, 'AI 仅复核规则层产生的候选定义');
    const fingerprint = definition => JSON.stringify([
      definition.id,
      normalizeDefinition(definition).normalizedHash,
      definition.scope,
      definition.centers || [],
      definition.recognized_object,
      definition.priority,
      normalizeText(definition.access_mode),
      normalizeText(definition.reference_result),
      normalizeText(definition.reference_materials),
    ]);
    const inputPair = [ fingerprint(left), fingerprint(right) ].sort();
    const inputHash = crypto.createHash('sha256').update(JSON.stringify(inputPair)).digest('hex');
    const aiService = this.ctx.service.aiProvider;
    const aiConfig = await this.ctx.service.systemSetting.getAiConfig({ includeKey: false });
    const job = await repository.createAiJob({
      leftId,
      rightId,
      inputHash,
      algorithmVersion: 'trigram-weighted-v1',
      promptVersion: 'dedupe-v1',
      modelName: aiConfig.model || 'unconfigured',
    });
    if (job.status === 'completed' && job.result) return job;
    try {
      const result = await aiService.classifyPair(left, right);
      if (result.result.recommendedCanonicalId && ![ left.id, right.id ].includes(result.result.recommendedCanonicalId)) {
        result.result.recommendedCanonicalId = null;
      }
      return repository.completeAiJob(job.id, result);
    } catch (err) {
      await repository.failAiJob(job.id, err);
      throw err;
    }
  }

  async analyzePair(left, right) {
    const normalized = normalizeDefinition(left);
    const normalizedRight = normalizeDefinition(right);
    return {
      relation: scoreDefinition(normalized, normalizedRight) >= 0.92 ? 'duplicate' : 'uncertain',
      confidence: scoreDefinition(normalized, normalizedRight),
      differences: [],
      reason: '规则层候选判断；配置 AI 服务后由 AiProvider 进行语义复核。',
      recommendedCanonicalId: left.id,
    };
  }

  async review({ leftId, rightId, decision, canonicalId, reviewerId, notes, confirmConflicts = false, editedDefinition = null }) {
    if (!leftId || !rightId || leftId === rightId) this.ctx.throw(400, '请提供两条不同的监督定义');
    const candidate = await this.ctx.app.db.query(`
      SELECT 1 FROM supervision_definition_candidates
      WHERE (id = $1 AND candidate_id = $2) OR (id = $2 AND candidate_id = $1)
      LIMIT 1`, [ leftId, rightId ]);
    if (!candidate.rowCount) this.ctx.throw(400, '仅可复核规则层生成的候选定义');
    const edited = editedDefinition
      ? this.ctx.service.supervisionDefinition.normalize(editedDefinition)
      : null;
    if (editedDefinition && decision !== 'duplicate') this.ctx.throw(400, '仅合并时可提交编辑后的检查方案');
    const client = await this.ctx.app.db.connect();
    try {
      await client.query('BEGIN');
      const review = await client.query(`
        INSERT INTO supervision_definition_reviews
          (left_definition_id, right_definition_id, decision, canonical_definition_id, reviewer_id, notes)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`, [ leftId, rightId, decision, canonicalId || null, reviewerId, notes || null ]);
      if (decision === 'duplicate') {
        if (!canonicalId || ![ leftId, rightId ].includes(canonicalId)) {
          this.ctx.throw(400, '确认重复时 canonicalId 必须是候选定义之一');
        }
        const mergedId = canonicalId === leftId ? rightId : leftId;
        const locked = await client.query(`
          SELECT id, plan_number, frequency, steps, access_mode, status, scope, recognized_object,
                 priority, reference_result, reference_materials
          FROM supervision_definitions WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ [ leftId, rightId ] ]);
        if (locked.rows.length !== 2 || locked.rows.some(item => item.status !== 'active')) this.ctx.throw(409, '候选定义已发生变化，请刷新后再复核');
        const loser = locked.rows.find(item => item.id === mergedId);
        const winner = locked.rows.find(item => item.id === canonicalId);
        const conflicts = edited ? [] : definitionConflicts(loser, winner);
        if (conflicts.length && !confirmConflicts) {
          this.ctx.throw(409, `归并存在字段冲突（${conflicts.map(([, label ]) => label).join('、')}），需明确确认后重试`);
        }
        if (edited) {
          const availableItems = await client.query(
            'SELECT id FROM standard_items WHERE id = ANY($1::uuid[])',
            [ edited.standardItemIds ]
          );
          if (availableItems.rowCount !== edited.standardItemIds.length) {
            this.ctx.throw(400, '所选标准项不存在或已删除');
          }
          const canonicalObjectId = await this.repository.ensureCanonicalObject(
            client,
            edited.fields.objectName,
            edited.fields.objectCategory
          );
          await client.query(`
            UPDATE supervision_definitions
            SET object_name = $2, scope = $3, recognized_object = $4, object_category = $5,
                check_layer = $6, check_method = $7, description = $8, steps = $9,
                frequency = $10, access_mode = $11, priority = $12, reference_result = $13,
                reference_materials = $14, normalized_hash = $15, canonical_object_id = $16,
                updated_at = now()
            WHERE id = $1 AND status = 'active'`, [
            canonicalId, edited.fields.objectName, edited.fields.scope || null,
            edited.fields.recognizedObject, edited.fields.objectCategory || null,
            edited.fields.checkLayer || null, edited.fields.checkMethod, edited.fields.description,
            edited.fields.steps || null, edited.fields.frequency || null,
            edited.fields.accessMode || null, edited.fields.priority || null,
            edited.fields.referenceResult || null, edited.fields.referenceMaterials || null,
            edited.fields.normalizedHash, canonicalObjectId,
          ]);
          await client.query('DELETE FROM supervision_definition_standard_items WHERE definition_id = $1', [ canonicalId ]);
          for (const standardItemId of edited.standardItemIds) {
            await client.query(`
              INSERT INTO supervision_definition_standard_items (definition_id, standard_item_id)
              SELECT $1, id FROM standard_items WHERE id = $2`, [ canonicalId, standardItemId ]);
          }
          await client.query('DELETE FROM supervision_definition_centers WHERE definition_id = $1', [ canonicalId ]);
          for (const centerName of edited.fields.centers || []) {
            await client.query(`
              INSERT INTO supervision_definition_centers (definition_id, center_name)
              VALUES ($1, $2)`, [ canonicalId, centerName ]);
          }
        }
        const updated = await client.query(`
          UPDATE supervision_definitions
          SET status = 'merged', merged_into_id = $1, updated_at = now()
          WHERE id = $2 AND status = 'active' RETURNING id`, [ canonicalId, mergedId ]);
        if (!updated.rowCount) this.ctx.throw(409, '待归并定义已被其他操作更新');
        if (!edited) {
          await client.query(`
            INSERT INTO supervision_definition_standard_items (definition_id, standard_item_id)
            SELECT $1, standard_item_id
            FROM supervision_definition_standard_items
            WHERE definition_id = $2
            ON CONFLICT DO NOTHING`, [ canonicalId, mergedId ]);
          await client.query(`
            INSERT INTO supervision_definition_centers (definition_id, center_name)
            SELECT $1, center_name FROM supervision_definition_centers WHERE definition_id = $2
            ON CONFLICT DO NOTHING`, [ canonicalId, mergedId ]);
        }
        await client.query('DELETE FROM supervision_definition_standard_items WHERE definition_id = $1', [ mergedId ]);
        await client.query('DELETE FROM supervision_definition_centers WHERE definition_id = $1', [ mergedId ]);
        const mergedNumber = String(loser.plan_number || '').padStart(3, '0');
        const winnerNumber = String(winner.plan_number || '').padStart(3, '0');
        await client.query(`
          UPDATE supervision_definitions
          SET change_history = change_history || jsonb_build_array(jsonb_build_object(
            'at', now(), 'action', 'merge',
            'summary', $2::text
          ))
          WHERE id = $1`, [
          canonicalId,
          `方案归并：将方案 ${mergedNumber} 并入本方案${notes ? `；复核备注：${notes}` : ''}`,
        ]);
        await client.query(`
          UPDATE supervision_definitions
          SET change_history = change_history || jsonb_build_array(jsonb_build_object(
            'at', now(), 'action', 'merged',
            'summary', $2::text
          ))
          WHERE id = $1`, [ mergedId, `方案归并：本方案已并入方案 ${winnerNumber}` ]);
        await client.query(`
          INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
          VALUES ($1, 'merge', 'supervision_definition', $2, $3)`, [
          reviewerId, canonicalId, JSON.stringify({
            mergedId,
            reviewId: review.rows[0].id,
            conflicts: conflicts.map(([ field ]) => field),
            edited: Boolean(edited),
            standardItemIds: edited?.standardItemIds || null,
          }),
        ]);
      }
      await client.query('COMMIT');
      return review.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = DedupeService;
