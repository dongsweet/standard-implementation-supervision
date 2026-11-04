'use strict';

class SupervisionDefinitionRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listCandidates(limit = 50) {
    const result = await this.pool.query(`
      SELECT id, candidate_id, object_name, object_category, check_layer,
             check_method, description, steps, frequency, access_mode, status,
             merged_into_id, normalized_hash, similarity_score, candidate_type,
             candidate_object_name, candidate_object_category, candidate_check_layer,
             candidate_check_method, candidate_description, candidate_steps, candidate_frequency, candidate_access_mode,
             standard_item_codes, candidate_standard_item_codes, execution_count, candidate_execution_count, created_at
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
        (left_definition_id, right_definition_id, input_hash, algorithm_version, prompt_version, model_name, status, started_at, attempt_count)
      VALUES ($1, $2, $3, $4, $5, $6, 'running', now(), 1)
      ON CONFLICT (input_hash, model_name, prompt_version)
      DO UPDATE SET status = CASE WHEN ai_dedupe_jobs.status = 'completed' THEN 'completed' ELSE 'running' END,
        attempt_count = ai_dedupe_jobs.attempt_count + CASE WHEN ai_dedupe_jobs.status = 'completed' THEN 0 ELSE 1 END,
        started_at = CASE WHEN ai_dedupe_jobs.status = 'completed' THEN ai_dedupe_jobs.started_at ELSE now() END,
        error_message = CASE WHEN ai_dedupe_jobs.status = 'completed' THEN ai_dedupe_jobs.error_message ELSE NULL END
      RETURNING *, (xmax = 0) AS inserted`, [ leftId, rightId, inputHash, algorithmVersion, promptVersion, modelName || null ]);
    return result.rows[0];
  }

  async completeAiJob(jobId, result, client = this.pool) {
    const query = await client.query(`
      UPDATE ai_dedupe_jobs
      SET status = 'completed', result = $2, provider_status = $3, duration_ms = $4,
          error_message = NULL, completed_at = now()
      WHERE id = $1 RETURNING *`, [ jobId, JSON.stringify(result.result), result.providerStatus, result.durationMs ]);
    return query.rows[0];
  }

  async failAiJob(jobId, errorMessage, client = this.pool) {
    const query = await client.query(`
      UPDATE ai_dedupe_jobs
      SET status = 'failed', error_message = $2, provider_status = $3, duration_ms = $4, completed_at = now()
      WHERE id = $1 RETURNING *`, [ jobId, errorMessage.message, errorMessage.providerStatus || null, errorMessage.durationMs || null ]);
    return query.rows[0];
  }
}

module.exports = SupervisionDefinitionRepository;
