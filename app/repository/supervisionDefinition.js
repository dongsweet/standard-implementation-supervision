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

  async listDefinitions() {
    const result = await this.pool.query(`
      SELECT d.id, d.object_name, d.object_category, d.check_layer, d.check_method,
             d.description, d.steps, d.frequency, d.access_mode, d.status,
             d.merged_into_id, d.created_at, d.updated_at,
             COALESCE(json_agg(json_build_object(
               'id', si.id, 'code', si.item_code, 'title', si.title,
               'standardCode', s.code, 'version', sv.version
             ) ORDER BY s.code, sv.version, si.item_code)
             FILTER (WHERE si.id IS NOT NULL), '[]'::json) AS standard_items
      FROM supervision_definitions d
      LEFT JOIN supervision_definition_standard_items dsi ON dsi.definition_id = d.id
      LEFT JOIN standard_items si ON si.id = dsi.standard_item_id
      LEFT JOIN standard_versions sv ON sv.id = si.standard_version_id
      LEFT JOIN standards s ON s.id = sv.standard_id
      GROUP BY d.id
      ORDER BY d.status, d.created_at DESC`);
    return result.rows;
  }

  async listStandardItems() {
    const result = await this.pool.query(`
      SELECT si.id, si.item_code, si.title, s.code AS standard_code, sv.version
      FROM standard_items si
      JOIN standard_versions sv ON sv.id = si.standard_version_id
      JOIN standards s ON s.id = sv.standard_id
      ORDER BY s.code, sv.version, si.item_code`);
    return result.rows;
  }

  async create({ fields, standardItemIds }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        INSERT INTO supervision_definitions
          (object_name, object_category, check_layer, check_method, description, steps, frequency, access_mode, normalized_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *`, [
        fields.objectName, fields.objectCategory || null, fields.checkLayer || null,
        fields.checkMethod, fields.description, fields.steps || null,
        fields.frequency || null, fields.accessMode || null, fields.normalizedHash,
      ]);
      for (const standardItemId of standardItemIds) {
        await client.query(`
          INSERT INTO supervision_definition_standard_items (definition_id, standard_item_id)
          SELECT $1, id FROM standard_items WHERE id = $2
          ON CONFLICT DO NOTHING`, [ result.rows[0].id, standardItemId ]);
      }
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async update(id, { fields, standardItemIds }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        UPDATE supervision_definitions
        SET object_name = $2, object_category = $3, check_layer = $4,
            check_method = $5, description = $6, steps = $7, frequency = $8,
            access_mode = $9, normalized_hash = $10, updated_at = now()
        WHERE id = $1 AND status = 'active'
        RETURNING *`, [
        id, fields.objectName, fields.objectCategory || null, fields.checkLayer || null,
        fields.checkMethod, fields.description, fields.steps || null,
        fields.frequency || null, fields.accessMode || null, fields.normalizedHash,
      ]);
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('DELETE FROM supervision_definition_standard_items WHERE definition_id = $1', [ id ]);
      for (const standardItemId of standardItemIds) {
        await client.query(`
          INSERT INTO supervision_definition_standard_items (definition_id, standard_item_id)
          SELECT $1, id FROM standard_items WHERE id = $2
          ON CONFLICT DO NOTHING`, [ id, standardItemId ]);
      }
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
