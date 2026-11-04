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
    const inputHash = crypto.createHash('sha256').update(JSON.stringify({ left, right })).digest('hex');
    const provider = this.ctx.service.aiProvider;
    const job = await repository.createAiJob({
      leftId,
      rightId,
      inputHash,
      algorithmVersion: 'trigram-weighted-v1',
      promptVersion: 'dedupe-v1',
      modelName: this.config.ai.model || 'unconfigured',
    });
    if (job.status === 'completed' && job.result) return job;
    try {
      const result = await provider.classifyPair(left, right);
      return repository.completeAiJob(job.id, result);
    } catch (err) {
      await repository.failAiJob(job.id, err.message);
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

  async review({ leftId, rightId, decision, canonicalId, reviewerId, notes }) {
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
        await client.query(`
          UPDATE supervision_definitions
          SET status = 'merged', merged_into_id = $1, updated_at = now()
          WHERE id = $2 AND status = 'active'`, [ canonicalId, mergedId ]);
        await client.query(`
          INSERT INTO supervision_definition_standard_items (definition_id, standard_item_id)
          SELECT $1, standard_item_id
          FROM supervision_definition_standard_items
          WHERE definition_id = $2
          ON CONFLICT DO NOTHING`, [ canonicalId, mergedId ]);
        await client.query(`
          INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
          VALUES ($1, 'merge', 'supervision_definition', $2, $3)`, [ reviewerId, canonicalId, JSON.stringify({ mergedId, reviewId: review.rows[0].id }) ]);
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
