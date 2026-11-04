'use strict';

class SupervisionDefinitionRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listCandidates(limit = 50) {
    const result = await this.pool.query(`
      SELECT id, candidate_id, object_name, object_category, check_layer,
             check_method, description, steps, frequency, status,
             merged_into_id, normalized_hash, similarity_score, candidate_type
      FROM supervision_definition_candidates
      ORDER BY candidate_type = 'exact_duplicate_candidate' DESC,
               similarity_score DESC NULLS LAST, created_at DESC
      LIMIT $1`, [ limit ]);
    return result.rows;
  }

  async findById(id, client = this.pool) {
    const result = await client.query(`
      SELECT id, object_name, object_category, check_layer, check_method,
             description, steps, frequency, access_mode, normalized_hash, status
      FROM supervision_definitions WHERE id = $1`, [ id ]);
    return result.rows[0] || null;
  }

  async createAiJob({ leftId, rightId, inputHash, algorithmVersion, promptVersion, modelName }, client = this.pool) {
    const result = await client.query(`
      INSERT INTO ai_dedupe_jobs
        (left_definition_id, right_definition_id, input_hash, algorithm_version, prompt_version, model_name, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'running')
      ON CONFLICT (input_hash, model_name, prompt_version)
      DO UPDATE SET status = ai_dedupe_jobs.status
      RETURNING *`, [ leftId, rightId, inputHash, algorithmVersion, promptVersion, modelName || null ]);
    return result.rows[0];
  }

  async completeAiJob(jobId, result, client = this.pool) {
    const query = await client.query(`
      UPDATE ai_dedupe_jobs
      SET status = 'completed', result = $2, completed_at = now()
      WHERE id = $1 RETURNING *`, [ jobId, JSON.stringify(result) ]);
    return query.rows[0];
  }

  async failAiJob(jobId, errorMessage, client = this.pool) {
    const query = await client.query(`
      UPDATE ai_dedupe_jobs
      SET status = 'failed', error_message = $2, completed_at = now()
      WHERE id = $1 RETURNING *`, [ jobId, errorMessage ]);
    return query.rows[0];
  }
}

module.exports = SupervisionDefinitionRepository;
