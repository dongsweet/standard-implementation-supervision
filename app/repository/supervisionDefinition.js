'use strict';

class SupervisionDefinitionRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listCandidates(limit = 50) {
    const result = await this.pool.query(`
      SELECT v.id, v.candidate_id, v.object_name, v.object_category, v.check_layer,
             v.check_method, v.description, v.steps, v.frequency, v.access_mode, v.status,
             v.merged_into_id, v.normalized_hash, v.similarity_score,
             CASE WHEN v.candidate_type = 'exact_duplicate_candidate'
               AND d.recognized_object IS NOT DISTINCT FROM c.recognized_object
               AND d.priority IS NOT DISTINCT FROM c.priority
               AND d.access_mode IS NOT DISTINCT FROM c.access_mode
               AND d.reference_result IS NOT DISTINCT FROM c.reference_result
               AND d.reference_materials IS NOT DISTINCT FROM c.reference_materials
               THEN 'exact_duplicate_candidate' ELSE 'similar_candidate' END AS candidate_type,
             v.candidate_object_name, v.candidate_object_category, v.candidate_check_layer,
             v.candidate_check_method, v.candidate_description, v.candidate_steps, v.candidate_frequency, v.candidate_access_mode,
             v.standard_item_codes, v.candidate_standard_item_codes, v.execution_count, v.candidate_execution_count, v.created_at,
             d.scope, d.recognized_object, d.priority, d.reference_result, d.reference_materials,
             v.centers, c.scope AS candidate_scope, c.recognized_object AS candidate_recognized_object,
             v.candidate_centers,
             c.priority AS candidate_priority, c.reference_result AS candidate_reference_result,
             c.reference_materials AS candidate_reference_materials
      FROM supervision_definition_candidates v
      JOIN supervision_definitions d ON d.id = v.id
      JOIN supervision_definitions c ON c.id = v.candidate_id
      WHERE NOT EXISTS (
        SELECT 1 FROM supervision_definition_reviews r
        WHERE r.decision IN ('similar_but_distinct', 'unrelated')
          AND ((r.left_definition_id = v.id AND r.right_definition_id = v.candidate_id)
            OR (r.left_definition_id = v.candidate_id AND r.right_definition_id = v.id))
      )
      ORDER BY candidate_type = 'exact_duplicate_candidate' DESC,
               v.similarity_score DESC NULLS LAST, v.created_at DESC
      LIMIT $1`, [ limit ]);
    return result.rows;
  }

  async listDefinitions({ search = '', status = '', priority = '', checkMethod = '', center = '', page = 1, pageSize = 20 } = {}) {
    const conditions = [];
    const values = [];
    if (search) {
      values.push(`%${search}%`);
      const searchParameter = `$${values.length}`;
      conditions.push(`(
        (CASE WHEN d.plan_number < 1000 THEN lpad(d.plan_number::text, 3, '0') ELSE d.plan_number::text END) ILIKE ${searchParameter}
        OR d.object_name ILIKE ${searchParameter}
        OR COALESCE(d.scope, '') ILIKE ${searchParameter}
        OR COALESCE(d.object_category, '') ILIKE ${searchParameter}
        OR COALESCE(d.check_layer, '') ILIKE ${searchParameter}
        OR d.check_method ILIKE ${searchParameter}
        OR d.description ILIKE ${searchParameter}
        OR COALESCE(d.steps, '') ILIKE ${searchParameter}
        OR EXISTS (
          SELECT 1
          FROM supervision_definition_standard_items filter_dsi
          JOIN standard_items filter_si ON filter_si.id = filter_dsi.standard_item_id
          JOIN standard_versions filter_sv ON filter_sv.id = filter_si.standard_version_id
          JOIN standards filter_s ON filter_s.id = filter_sv.standard_id
          WHERE filter_dsi.definition_id = d.id
            AND (filter_si.standard_number ILIKE ${searchParameter}
              OR filter_si.item_code ILIKE ${searchParameter}
              OR filter_s.code ILIKE ${searchParameter}
              OR filter_sv.version ILIKE ${searchParameter})
        )
      )`);
    }
    if (status) {
      values.push(status);
      conditions.push(`d.status = $${values.length}`);
    }
    if (priority === '未指定') {
      conditions.push('d.priority IS NULL');
    } else if (priority) {
      values.push(priority);
      conditions.push(`d.priority = $${values.length}`);
    }
    if (checkMethod) {
      values.push(`%${checkMethod}%`);
      conditions.push(`d.check_method ILIKE $${values.length}`);
    }
    if (center) {
      values.push(center);
      conditions.push(`EXISTS (SELECT 1 FROM supervision_definition_centers dc WHERE dc.definition_id = d.id AND dc.center_name = $${values.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await this.pool.query(`
      SELECT count(*)::integer AS total
      FROM supervision_definitions d
      ${where}`, values);
    const total = countResult.rows[0].total;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(Math.max(1, Number.isSafeInteger(page) ? page : 1), pageCount);
    const offset = (currentPage - 1) * pageSize;
    const listValues = [ ...values, pageSize, offset ];
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;
    const result = await this.pool.query(`
      SELECT d.id, d.plan_number, d.object_name, d.scope, d.recognized_object, d.object_category, d.check_layer, d.check_method,
             d.description, d.steps, d.frequency, d.access_mode, d.priority,
             d.reference_result, d.reference_materials, d.status,
             d.merged_into_id, d.created_at, d.updated_at,
             COALESCE(json_agg(json_build_object(
               'id', si.id, 'code', si.item_code, 'standardNumber', si.standard_number,
               'title', si.title, 'chapterCode', sc.code, 'chapterName', sc.name,
               'standardCode', s.code, 'version', sv.version
             ) ORDER BY s.code, sv.version, si.item_code)
             FILTER (WHERE si.id IS NOT NULL), '[]'::json) AS standard_items,
             COALESCE((SELECT json_agg(center_name ORDER BY center_name)
                        FROM supervision_definition_centers WHERE definition_id = d.id), '[]'::json) AS centers
      FROM supervision_definitions d
      LEFT JOIN supervision_definition_standard_items dsi ON dsi.definition_id = d.id
      LEFT JOIN standard_items si ON si.id = dsi.standard_item_id
      LEFT JOIN standard_chapters sc ON sc.id = si.chapter_id
      LEFT JOIN standard_versions sv ON sv.id = si.standard_version_id
      LEFT JOIN standards s ON s.id = sv.standard_id
      ${where}
      GROUP BY d.id
      ORDER BY d.status, d.plan_number
      LIMIT $${limitParameter} OFFSET $${offsetParameter}`, listValues);
    return { rows: result.rows, total, page: currentPage, pageSize, pageCount };
  }

  async listDefinitionMethods() {
    const result = await this.pool.query(`
      SELECT check_method FROM supervision_definitions
      ORDER BY check_method`);
    return result.rows.map(row => row.check_method);
  }

  async listDefinitionScopes() {
    const result = await this.pool.query(`
      SELECT DISTINCT scope FROM supervision_definitions
      WHERE scope IS NOT NULL AND btrim(scope) <> ''
      ORDER BY scope`);
    return result.rows.map(row => row.scope);
  }

  async listDefinitionCenters() {
    const result = await this.pool.query(`
      SELECT DISTINCT center_name FROM supervision_definition_centers
      ORDER BY center_name`);
    return result.rows.map(row => row.center_name);
  }

  async listCenterObjects({ center = '', search = '', page = 1, pageSize = 20 } = {}) {
    const conditions = [ `d.status = 'active'` ];
    const values = [];
    if (center) {
      values.push(center);
      conditions.push(`dc.center_name = $${values.length}`);
    }
    if (search) {
      values.push(`%${search}%`);
      conditions.push(`d.object_name ILIKE $${values.length}`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const countResult = await this.pool.query(`
      SELECT count(*)::integer AS total
      FROM (
        SELECT dc.center_name, d.object_name
        FROM supervision_definition_centers dc
        JOIN supervision_definitions d ON d.id = dc.definition_id
        ${where}
        GROUP BY dc.center_name, d.object_name
      ) grouped`, values);
    const total = Number(countResult.rows[0]?.total || 0);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(Math.max(Number(page) || 1, 1), pageCount);
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;
    const result = await this.pool.query(`
      SELECT dc.center_name,
             d.object_name,
             count(DISTINCT d.id)::integer AS plan_count,
             count(DISTINCT dsi.standard_item_id)::integer AS standard_item_count,
             COALESCE(array_agg(DISTINCT d.check_method ORDER BY d.check_method)
               FILTER (WHERE d.check_method IS NOT NULL), ARRAY[]::text[]) AS check_methods,
             COALESCE(array_agg(DISTINCT d.plan_number ORDER BY d.plan_number)
               FILTER (WHERE d.plan_number IS NOT NULL), ARRAY[]::integer[]) AS plan_numbers
      FROM supervision_definition_centers dc
      JOIN supervision_definitions d ON d.id = dc.definition_id
      LEFT JOIN supervision_definition_standard_items dsi ON dsi.definition_id = d.id
      ${where}
      GROUP BY dc.center_name, d.object_name
      ORDER BY dc.center_name, d.object_name
      LIMIT $${limitParameter} OFFSET $${offsetParameter}`, [ ...values, pageSize, (currentPage - 1) * pageSize ]);
    return { rows: result.rows, total, page: currentPage, pageSize, pageCount };
  }

  async listStandardItems() {
    const result = await this.pool.query(`
      SELECT si.id, si.item_code, si.standard_number, si.title, s.code AS standard_code, sv.version
      FROM standard_items si
      JOIN standard_versions sv ON sv.id = si.standard_version_id
      JOIN standards s ON s.id = sv.standard_id
      ORDER BY s.code, sv.version, si.item_code`);
    return result.rows;
  }

  async create({ fields, standardItemIds }, actorId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const availableItems = await client.query('SELECT id FROM standard_items WHERE id = ANY($1::uuid[])', [ standardItemIds ]);
      if (availableItems.rowCount !== standardItemIds.length) {
        const error = new Error('所选标准项不存在或已删除');
        error.code = 'INVALID_STANDARD_ITEMS';
        throw error;
      }
      const result = await client.query(`
        INSERT INTO supervision_definitions
          (object_name, scope, recognized_object, object_category, check_layer, check_method, description, steps, frequency, access_mode, priority, reference_result, reference_materials, normalized_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *`, [
        fields.objectName, fields.scope || null, fields.recognizedObject, fields.objectCategory || null, fields.checkLayer || null,
        fields.checkMethod, fields.description, fields.steps || null, fields.frequency || null, fields.accessMode || null,
        fields.priority || null, fields.referenceResult || null, fields.referenceMaterials || null, fields.normalizedHash,
      ]);
      for (const standardItemId of standardItemIds) {
        await client.query(`
          INSERT INTO supervision_definition_standard_items (definition_id, standard_item_id)
          SELECT $1, id FROM standard_items WHERE id = $2
          ON CONFLICT DO NOTHING`, [ result.rows[0].id, standardItemId ]);
      }
      for (const centerName of fields.centers || []) {
        await client.query(`INSERT INTO supervision_definition_centers (definition_id, center_name)
          VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ result.rows[0].id, centerName ]);
      }
      await client.query(`
        INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'create_supervision_definition', 'supervision_definition', $2, $3)`, [
        actorId || null, result.rows[0].id,
        JSON.stringify({ objectName: fields.objectName, standardItemIds }),
      ]);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async update(id, { fields, standardItemIds }, actorId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const availableItems = await client.query('SELECT id FROM standard_items WHERE id = ANY($1::uuid[])', [ standardItemIds ]);
      if (availableItems.rowCount !== standardItemIds.length) {
        const error = new Error('所选标准项不存在或已删除');
        error.code = 'INVALID_STANDARD_ITEMS';
        throw error;
      }
      const result = await client.query(`
        UPDATE supervision_definitions
        SET object_name = $2, scope = $3, recognized_object = $4, object_category = $5, check_layer = $6,
            check_method = $7, description = $8, steps = $9, frequency = $10, access_mode = $11,
            priority = $12, reference_result = $13, reference_materials = $14, normalized_hash = $15, updated_at = now()
        WHERE id = $1 AND status = 'active'
        RETURNING *`, [
        id, fields.objectName, fields.scope || null, fields.recognizedObject, fields.objectCategory || null, fields.checkLayer || null,
        fields.checkMethod, fields.description, fields.steps || null, fields.frequency || null, fields.accessMode || null,
        fields.priority || null, fields.referenceResult || null, fields.referenceMaterials || null, fields.normalizedHash,
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
      await client.query('DELETE FROM supervision_definition_centers WHERE definition_id = $1', [ id ]);
      for (const centerName of fields.centers || []) {
        await client.query(`INSERT INTO supervision_definition_centers (definition_id, center_name)
          VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ id, centerName ]);
      }
      await client.query(`
        INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'update_supervision_definition', 'supervision_definition', $2, $3)`, [
        actorId || null, id,
        JSON.stringify({ objectName: fields.objectName, standardItemIds }),
      ]);
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
      SELECT id, object_name, scope, recognized_object, object_category, check_layer, check_method,
             description, steps, frequency, access_mode, priority, reference_result,
             reference_materials, normalized_hash, status,
             COALESCE((SELECT array_agg(center_name ORDER BY center_name)
                       FROM supervision_definition_centers WHERE definition_id = supervision_definitions.id), ARRAY[]::varchar[]) AS centers
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
