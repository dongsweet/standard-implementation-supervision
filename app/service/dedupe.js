'use strict';

const Service = require('egg').Service;
const crypto = require('node:crypto');
const { normalizeDefinition, scoreDefinition } = require('../lib/dedupe');
const SupervisionDefinitionRepository = require('../repository/supervisionDefinition');

class DedupeService extends Service {
  async listCandidates({ limit = 50 } = {}) {
    return new SupervisionDefinitionRepository(this.ctx.app.db).listCandidates(limit);
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
    const inputPair = [ normalizeDefinition(left).normalizedHash, normalizeDefinition(right).normalizedHash ].sort();
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

  async review({ leftId, rightId, decision, canonicalId, reviewerId, notes, confirmConflicts = false }) {
    if (!leftId || !rightId || leftId === rightId) this.ctx.throw(400, '请提供两条不同的监督定义');
    const candidate = await this.ctx.app.db.query(`
      SELECT 1 FROM supervision_definition_candidates
      WHERE (id = $1 AND candidate_id = $2) OR (id = $2 AND candidate_id = $1)
      LIMIT 1`, [ leftId, rightId ]);
    if (!candidate.rowCount) this.ctx.throw(400, '仅可复核规则层生成的候选定义');
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
          SELECT id, frequency, steps, access_mode, status
          FROM supervision_definitions WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ [ leftId, rightId ] ]);
        if (locked.rows.length !== 2 || locked.rows.some(item => item.status !== 'active')) this.ctx.throw(409, '候选定义已发生变化，请刷新后再复核');
        const loser = locked.rows.find(item => item.id === mergedId);
        const winner = locked.rows.find(item => item.id === canonicalId);
        const conflicts = [ 'frequency', 'steps', 'access_mode' ].filter(field => (loser[field] || '') !== (winner[field] || ''));
        if (conflicts.length && !confirmConflicts) this.ctx.throw(409, `归并存在字段冲突（${conflicts.join('、')}），需明确确认后重试`);
        const updated = await client.query(`
          UPDATE supervision_definitions
          SET status = 'merged', merged_into_id = $1, updated_at = now()
          WHERE id = $2 AND status = 'active' RETURNING id`, [ canonicalId, mergedId ]);
        if (!updated.rowCount) this.ctx.throw(409, '待归并定义已被其他操作更新');
        await client.query(`
          INSERT INTO supervision_definition_standard_items (definition_id, standard_item_id)
          SELECT $1, standard_item_id
          FROM supervision_definition_standard_items
          WHERE definition_id = $2
          ON CONFLICT DO NOTHING`, [ canonicalId, mergedId ]);
        await client.query('DELETE FROM supervision_definition_standard_items WHERE definition_id = $1', [ mergedId ]);
        await client.query(`
          INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
          VALUES ($1, 'merge', 'supervision_definition', $2, $3)`, [ reviewerId, canonicalId, JSON.stringify({ mergedId, reviewId: review.rows[0].id, conflicts }) ]);
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
