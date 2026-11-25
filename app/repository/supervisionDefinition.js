'use strict';

const { normalizeDefinition, normalizeText } = require('../lib/dedupe');

class SupervisionDefinitionRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async ensureCanonicalObject(client, name, categoryName = '', centerName = null) {
    const canonicalName = String(name || '').trim();
    if (!canonicalName) return null;
    const normalizedName = normalizeText(canonicalName).replace(/\s+/g, '');
    const categoryText = String(categoryName || '').trim();
    let categoryId = null;
    if (categoryText) {
      const category = await client.query(`
        INSERT INTO supervision_object_categories (name)
        VALUES ($1) ON CONFLICT (name) DO UPDATE SET updated_at = now()
        RETURNING id`, [ categoryText ]);
      categoryId = category.rows[0].id;
    }
    let object = await client.query(`
      SELECT id, category_id FROM supervision_objects
      WHERE canonical_name = $1 AND status = 'active'
      ORDER BY created_at, id LIMIT 1 FOR UPDATE`, [ canonicalName ]);
    if (!object.rowCount) {
      object = await client.query(`
        INSERT INTO supervision_objects (canonical_name, normalized_name, category_id)
        VALUES ($1, $2, $3) RETURNING id, category_id`, [ canonicalName, normalizedName, categoryId ]);
    } else if (categoryId && !object.rows[0].category_id) {
      await client.query('UPDATE supervision_objects SET category_id = $2, updated_at = now() WHERE id = $1', [ object.rows[0].id, categoryId ]);
    }
    const objectId = object.rows[0].id;
    await client.query(`
      INSERT INTO supervision_object_aliases (object_id, alias_name, normalized_name, center_name, source)
      VALUES ($1, $2, $3, $4, 'plan') ON CONFLICT DO NOTHING`, [ objectId, canonicalName, normalizedName, centerName ]);
    return objectId;
  }

  async listCandidates({ threshold = 0.6, limit = 1000 } = {}) {
    const result = await this.pool.query(`
      SELECT v.id, v.candidate_id, d.plan_number, c.plan_number AS candidate_plan_number,
             v.object_name, v.object_category, v.check_layer,
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
      WHERE (v.candidate_type = 'exact_duplicate_candidate' OR v.similarity_score >= $1)
        AND NOT EXISTS (
          SELECT 1 FROM supervision_definition_reviews r
          WHERE r.decision IN ('similar_but_distinct', 'unrelated')
            AND ((r.left_definition_id = v.id AND r.right_definition_id = v.candidate_id)
              OR (r.left_definition_id = v.candidate_id AND r.right_definition_id = v.id))
        )
      ORDER BY candidate_type = 'exact_duplicate_candidate' DESC,
               v.similarity_score DESC NULLS LAST, v.created_at DESC
      LIMIT $2`, [ threshold, limit ]);
    return result.rows;
  }

  async listDefinitionAiJobs() {
    const result = await this.pool.query(`
      SELECT DISTINCT ON (least(left_definition_id::text, right_definition_id::text),
                          greatest(left_definition_id::text, right_definition_id::text))
             id, left_definition_id, right_definition_id, status, result, error_message,
             model_name, prompt_version, created_at, completed_at
      FROM ai_dedupe_jobs
      WHERE status IN ('completed', 'failed')
      ORDER BY least(left_definition_id::text, right_definition_id::text),
               greatest(left_definition_id::text, right_definition_id::text),
               created_at DESC`);
    return result.rows;
  }

  async listDefinitionReviews() {
    const result = await this.pool.query(`
      SELECT r.id, r.left_definition_id, r.right_definition_id, r.decision,
             r.canonical_definition_id, r.notes, r.created_at,
             l.object_name AS left_object_name, c.object_name AS right_object_name,
             canonical.object_name AS canonical_object_name
      FROM supervision_definition_reviews r
      JOIN supervision_definitions l ON l.id = r.left_definition_id
      JOIN supervision_definitions c ON c.id = r.right_definition_id
      LEFT JOIN supervision_definitions canonical ON canonical.id = r.canonical_definition_id
      ORDER BY r.created_at DESC`);
    return result.rows;
  }

  async listDefinitions({ search = '', status = '', priority = '', checkMethod = '', center = '', objectId = '', page = 1, pageSize = 20 } = {}) {
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
    if (objectId) {
      values.push(objectId);
      conditions.push(`d.canonical_object_id = $${values.length}`);
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
      SELECT d.id, d.plan_number, d.object_name, d.canonical_object_id, d.scope, d.recognized_object,
             d.object_category, d.check_layer, d.check_method,
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

  async listObjectWorkbench({ center = '', search = '', category = '', page = 1, pageSize = 20 } = {}) {
    const conditions = [ `o.status = 'active'` ];
    const values = [];
    if (center) {
      values.push(center);
      conditions.push(`EXISTS (SELECT 1 FROM supervision_definition_centers fdc
        JOIN supervision_definitions fd ON fd.id = fdc.definition_id AND fd.status = 'active'
        WHERE fd.canonical_object_id = o.id AND fdc.center_name = $${values.length})`);
    }
    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(o.canonical_name ILIKE $${values.length}
        OR COALESCE(c.name, '') ILIKE $${values.length}
        OR EXISTS (SELECT 1 FROM supervision_object_aliases fa
          WHERE fa.object_id = o.id AND fa.alias_name ILIKE $${values.length}))`);
    }
    if (category === '未分类') {
      conditions.push('o.category_id IS NULL');
    } else if (category) {
      values.push(category);
      conditions.push(`c.name = $${values.length}`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const countResult = await this.pool.query(`
      SELECT count(*)::integer AS total
      FROM supervision_objects o
      LEFT JOIN supervision_object_categories c ON c.id = o.category_id
      ${where}`, values);
    const total = Number(countResult.rows[0]?.total || 0);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(Math.max(Number(page) || 1, 1), pageCount);
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;
    const result = await this.pool.query(`
      SELECT o.id, o.canonical_name, c.name AS object_category, o.notes,
             count(DISTINCT d.id)::integer AS plan_count,
             count(DISTINCT dsi.standard_item_id)::integer AS standard_item_count,
             COALESCE(array_agg(DISTINCT dc.center_name ORDER BY dc.center_name)
               FILTER (WHERE dc.center_name IS NOT NULL), ARRAY[]::text[]) AS centers,
             COALESCE(array_agg(DISTINCT oa.alias_name ORDER BY oa.alias_name)
               FILTER (WHERE oa.alias_name IS NOT NULL), ARRAY[]::text[]) AS aliases,
             COALESCE(array_agg(DISTINCT d.plan_number ORDER BY d.plan_number)
               FILTER (WHERE d.plan_number IS NOT NULL), ARRAY[]::bigint[]) AS plan_numbers,
             COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
               'id', d.id, 'planNumber', d.plan_number, 'objectName', d.object_name,
               'objectCategory', d.object_category, 'checkLayer', d.check_layer,
               'checkMethod', d.check_method, 'description', d.description,
               'steps', d.steps, 'frequency', d.frequency, 'accessMode', d.access_mode,
               'centers', COALESCE((
                 SELECT array_agg(plan_center.center_name ORDER BY plan_center.center_name)
                 FROM supervision_definition_centers plan_center
                 WHERE plan_center.definition_id = d.id
               ), ARRAY[]::varchar[])
             )) FILTER (WHERE d.id IS NOT NULL), '[]'::jsonb) AS plans
      FROM supervision_objects o
      LEFT JOIN supervision_object_categories c ON c.id = o.category_id
      LEFT JOIN supervision_definitions d ON d.canonical_object_id = o.id AND d.status = 'active'
      LEFT JOIN supervision_definition_standard_items dsi ON dsi.definition_id = d.id
      LEFT JOIN supervision_definition_centers dc ON dc.definition_id = d.id
      LEFT JOIN supervision_object_aliases oa ON oa.object_id = o.id
      ${where}
      GROUP BY o.id, c.name
      ORDER BY o.canonical_name
      LIMIT $${limitParameter} OFFSET $${offsetParameter}`, [ ...values, pageSize, (currentPage - 1) * pageSize ]);
    return { rows: result.rows, total, page: currentPage, pageSize, pageCount };
  }

  async listObjectPickerOptions() {
    const result = await this.pool.query(`
      SELECT o.id, o.canonical_name, c.id AS category_id, c.name AS object_category,
             COALESCE(array_agg(DISTINCT oa.alias_name ORDER BY oa.alias_name)
               FILTER (WHERE oa.alias_name IS NOT NULL), ARRAY[]::text[]) AS aliases
      FROM supervision_objects o
      LEFT JOIN supervision_object_categories c ON c.id = o.category_id
      LEFT JOIN supervision_object_aliases oa ON oa.object_id = o.id
      WHERE o.status = 'active'
      GROUP BY o.id, c.id, c.name
      ORDER BY o.canonical_name`);
    return result.rows;
  }

  async listObjectCategories() {
    const result = await this.pool.query(`
      SELECT c.id, c.name, c.description, c.status,
             count(DISTINCT o.id)::integer AS object_count
      FROM supervision_object_categories c
      LEFT JOIN supervision_objects o ON o.category_id = c.id AND o.status = 'active'
      WHERE c.status = 'active'
      GROUP BY c.id
      ORDER BY c.name`);
    return result.rows;
  }

  async updateObject(id, { canonicalName, categoryId, categoryName, notes }, actorId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let categoryResult = categoryId
        ? await client.query('SELECT id, name FROM supervision_object_categories WHERE id = $1 AND status = \'active\'', [ categoryId ])
        : { rowCount: 0, rows: [] };
      if (!categoryResult.rowCount && categoryName) {
        categoryResult = await client.query(`
          INSERT INTO supervision_object_categories (name)
          VALUES ($1)
          ON CONFLICT (name) DO UPDATE SET updated_at = now()
          RETURNING id, name`, [ categoryName ]);
      }
      if (categoryId && !categoryResult.rowCount) {
        const error = new Error('对象分类不存在');
        error.code = 'INVALID_OBJECT_CATEGORY';
        throw error;
      }
      categoryId = categoryResult.rows[0]?.id || null;
      const duplicate = await client.query(`
        SELECT id FROM supervision_objects
        WHERE id <> $1 AND status = 'active'
          AND normalized_name = lower(regexp_replace(btrim($2), '[[:space:][:punct:]]+', '', 'g'))
        LIMIT 1`, [ id, canonicalName ]);
      if (duplicate.rowCount) {
        const error = new Error('规范对象名称已对应其他对象，请先通过去重复核合并');
        error.code = 'DUPLICATE_SUPERVISION_OBJECT';
        throw error;
      }
      const definitions = await client.query(`
        SELECT d.id, d.object_name, d.check_layer, d.check_method, d.description, d.steps, d.frequency,
               COALESCE(array_agg(dc.center_name) FILTER (WHERE dc.center_name IS NOT NULL), ARRAY[]::text[]) AS centers
        FROM supervision_definitions d
        LEFT JOIN supervision_definition_centers dc ON dc.definition_id = d.id
        WHERE d.canonical_object_id = $1 AND d.status = 'active'
        GROUP BY d.id`, [ id ]);
      for (const definition of definitions.rows) {
        await client.query(`
          INSERT INTO supervision_object_aliases (object_id, alias_name, normalized_name, center_name, source)
          SELECT $1, $2, lower(regexp_replace(btrim($2), '[[:space:][:punct:]]+', '', 'g')), value, 'normalization'
          FROM unnest($3::text[]) AS value
          ON CONFLICT DO NOTHING`, [ id, definition.object_name, definition.centers ]);
        const normalizedHash = normalizeDefinition({
          object_name: canonicalName,
          object_category: categoryResult.rows[0]?.name || '',
          check_layer: definition.check_layer,
          check_method: definition.check_method,
          description: definition.description,
          steps: definition.steps,
          frequency: definition.frequency,
        }).normalizedHash;
        await client.query(`
          UPDATE supervision_definitions
          SET object_name = $2, object_category = $3, normalized_hash = $4, updated_at = now()
          WHERE id = $1`, [ definition.id, canonicalName, categoryResult.rows[0]?.name || null, normalizedHash ]);
      }
      const result = await client.query(`
        UPDATE supervision_objects
        SET canonical_name = $2, normalized_name = lower(regexp_replace(btrim($2), '[[:space:][:punct:]]+', '', 'g')),
            category_id = $3, notes = $4, updated_at = now()
        WHERE id = $1 AND status = 'active'
        RETURNING *`, [ id, canonicalName, categoryId || null, notes || null ]);
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(`
        INSERT INTO supervision_object_aliases (object_id, alias_name, normalized_name, source)
        VALUES ($1, $2, lower(regexp_replace(btrim($2), '[[:space:][:punct:]]+', '', 'g')), 'normalization')
        ON CONFLICT DO NOTHING`, [ id, canonicalName ]);
      await client.query(`
        INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'update_supervision_object', 'supervision_object', $2, $3)`, [
        actorId || null, id, JSON.stringify({ canonicalName, categoryId: categoryId || null }),
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

  async listObjectSplitPlans(sourceId) {
    const result = await this.pool.query(`
      SELECT d.id, d.plan_number, d.object_name, d.object_category, d.check_layer,
             d.check_method, d.description, d.frequency,
             COALESCE(array_agg(DISTINCT dc.center_name ORDER BY dc.center_name)
               FILTER (WHERE dc.center_name IS NOT NULL), ARRAY[]::text[]) AS centers
      FROM supervision_definitions d
      LEFT JOIN supervision_definition_centers dc ON dc.definition_id = d.id
      WHERE d.canonical_object_id = $1 AND d.status = 'active'
      GROUP BY d.id
      ORDER BY d.object_category, d.plan_number`, [ sourceId ]);
    return result.rows;
  }

  async getObjectById(id) {
    const result = await this.pool.query(`
      SELECT o.id, o.canonical_name, o.status, c.name AS object_category
      FROM supervision_objects o
      LEFT JOIN supervision_object_categories c ON c.id = o.category_id
      WHERE o.id = $1`, [ id ]);
    return result.rows[0] || null;
  }

  async mergeObject(sourceId, targetId, actorId) {
    if (sourceId === targetId) {
      const error = new Error('来源对象和保留对象不能相同');
      error.code = 'INVALID_OBJECT_MERGE';
      throw error;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const objects = await client.query(`
        SELECT id, canonical_name, category_id, status
        FROM supervision_objects
        WHERE id = ANY($1::uuid[])
        FOR UPDATE`, [ [ sourceId, targetId ] ]);
      const source = objects.rows.find(row => row.id === sourceId);
      const target = objects.rows.find(row => row.id === targetId);
      if (!source || !target || source.status !== 'active' || target.status !== 'active') {
        const error = new Error('来源对象或保留对象不存在');
        error.code = 'INVALID_OBJECT_MERGE';
        throw error;
      }
      const plans = await client.query(`
        SELECT d.id, d.object_name, d.object_category, d.check_layer, d.check_method,
               d.description, d.steps, d.frequency, d.plan_number
        FROM supervision_definitions d
        WHERE d.canonical_object_id = $1 AND d.status = 'active'
        ORDER BY d.plan_number
        FOR UPDATE`, [ sourceId ]);
      for (const plan of plans.rows) {
        const normalizedHash = normalizeDefinition({
          object_name: target.canonical_name,
          object_category: plan.object_category,
          check_layer: plan.check_layer,
          check_method: plan.check_method,
          description: plan.description,
          steps: plan.steps,
          frequency: plan.frequency,
        }).normalizedHash;
        await client.query(`
          UPDATE supervision_definitions
          SET object_name = $2, canonical_object_id = $3, normalized_hash = $4, updated_at = now()
          WHERE id = $1`, [ plan.id, target.canonical_name, targetId, normalizedHash ]);
      }
      const aliases = await client.query(`
        SELECT alias_name, normalized_name, center_name
        FROM supervision_object_aliases
        WHERE object_id = $1`, [ sourceId ]);
      const aliasRows = [
        ...aliases.rows,
        { alias_name: source.canonical_name, normalized_name: normalizeText(source.canonical_name).replace(/\s+/g, ''), center_name: null },
        ...plans.rows.map(plan => ({
          alias_name: plan.object_name,
          normalized_name: normalizeText(plan.object_name).replace(/\s+/g, ''),
          center_name: null,
        })),
      ];
      for (const alias of aliasRows) {
        if (!alias.alias_name) continue;
        await client.query(`
          INSERT INTO supervision_object_aliases (object_id, alias_name, normalized_name, center_name, source)
          VALUES ($1, $2, $3, $4, 'merge')
          ON CONFLICT DO NOTHING`, [ targetId, alias.alias_name, alias.normalized_name, alias.center_name || null ]);
      }
      await client.query(`DELETE FROM supervision_object_aliases WHERE object_id = $1`, [ sourceId ]);
      await client.query(`
        UPDATE supervision_objects
        SET status = 'merged', merged_into_id = $2, updated_at = now()
        WHERE id = $1`, [ sourceId, targetId ]);
      await client.query(`
        INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'merge_supervision_object', 'supervision_object', $2, $3)`, [
        actorId || null, targetId,
        JSON.stringify({
          sourceId,
          sourceName: source.canonical_name,
          targetId,
          targetName: target.canonical_name,
          affectedPlanIds: plans.rows.map(plan => plan.id),
          affectedPlanNumbers: plans.rows.map(plan => plan.plan_number),
        }),
      ]);
      await client.query('COMMIT');
      return {
        sourceId,
        targetId,
        targetName: target.canonical_name,
        affectedPlanCount: plans.rows.length,
        affectedPlanNumbers: plans.rows.map(plan => plan.plan_number),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createObjectCategory({ name, description }, actorId) {
    const result = await this.pool.query(`
      INSERT INTO supervision_object_categories (name, description)
      VALUES ($1, $2) RETURNING *`, [ name, description || null ]);
    await this.pool.query(`
      INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, 'create_supervision_object_category', 'supervision_object_category', $2, $3)`, [
      actorId || null, result.rows[0].id, JSON.stringify({ name }),
    ]);
    return result.rows[0];
  }

  async deleteObjectCategory(id, actorId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const category = await client.query(`
        SELECT id, name FROM supervision_object_categories
        WHERE id = $1 AND status = 'active'
        FOR UPDATE`, [ id ]);
      if (!category.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const usage = await client.query(`
        SELECT count(*)::integer AS object_count
        FROM supervision_objects
        WHERE category_id = $1`, [ id ]);
      if (Number(usage.rows[0]?.object_count || 0) > 0) {
        const error = new Error('该分类仍被规范对象使用，请先调整对象分类');
        error.code = 'CATEGORY_IN_USE';
        throw error;
      }
      const result = await client.query(`
        DELETE FROM supervision_object_categories
        WHERE id = $1 AND status = 'active'
        RETURNING id, name`, [ id ]);
      await client.query(`
        INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'delete_supervision_object_category', 'supervision_object_category', $2, $3)`, [
        actorId || null, id, JSON.stringify({ name: category.rows[0].name }),
      ]);
      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async setObjectCategory(id, categoryId, actorId) {
    const result = await this.pool.query(`
      UPDATE supervision_objects SET category_id = $2, updated_at = now()
      WHERE id = $1 AND status = 'active' RETURNING id, canonical_name`, [ id, categoryId || null ]);
    if (!result.rowCount) return null;
    await this.pool.query(`
      INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, 'classify_supervision_object', 'supervision_object', $2, $3)`, [
      actorId || null, id, JSON.stringify({ categoryId: categoryId || null }),
    ]);
    return result.rows[0];
  }

  async listCenterObjectEntries() {
    const result = await this.pool.query(`
      SELECT dc.center_name, d.object_name,
             count(DISTINCT d.id)::integer AS plan_count,
             count(DISTINCT dsi.standard_item_id)::integer AS standard_item_count,
             COALESCE(array_agg(DISTINCT d.plan_number ORDER BY d.plan_number)
               FILTER (WHERE d.plan_number IS NOT NULL), ARRAY[]::integer[]) AS plan_numbers,
             COALESCE(array_agg(DISTINCT d.object_category ORDER BY d.object_category)
               FILTER (WHERE d.object_category IS NOT NULL), ARRAY[]::text[]) AS object_categories,
             COALESCE(array_agg(DISTINCT d.check_layer ORDER BY d.check_layer)
               FILTER (WHERE d.check_layer IS NOT NULL), ARRAY[]::text[]) AS check_layers,
             COALESCE(array_agg(DISTINCT d.check_method ORDER BY d.check_method)
               FILTER (WHERE d.check_method IS NOT NULL), ARRAY[]::text[]) AS check_methods,
             COALESCE(array_agg(DISTINCT left(d.description, 300) ORDER BY left(d.description, 300))
               FILTER (WHERE d.description IS NOT NULL), ARRAY[]::text[]) AS descriptions
      FROM supervision_definition_centers dc
      JOIN supervision_definitions d ON d.id = dc.definition_id
      LEFT JOIN supervision_definition_standard_items dsi ON dsi.definition_id = d.id
      WHERE d.status = 'active'
      GROUP BY dc.center_name, d.object_name
      ORDER BY dc.center_name, d.object_name`);
    return result.rows;
  }

  async listCenterObjectReviews() {
    const result = await this.pool.query(`
      SELECT id, center_name, left_object_name, right_object_name, decision,
             canonical_object_name, notes, affected_plan_ids, created_at
      FROM supervision_object_dedupe_reviews
      ORDER BY created_at DESC`);
    return result.rows;
  }

  async centerObjectEntry(centerName, objectName, client = this.pool) {
    const result = await client.query(`
      SELECT dc.center_name, d.object_name,
             count(DISTINCT d.id)::integer AS plan_count,
             COALESCE(array_agg(DISTINCT d.plan_number ORDER BY d.plan_number)
               FILTER (WHERE d.plan_number IS NOT NULL), ARRAY[]::integer[]) AS plan_numbers,
             COALESCE(array_agg(DISTINCT d.check_method ORDER BY d.check_method)
               FILTER (WHERE d.check_method IS NOT NULL), ARRAY[]::text[]) AS check_methods
      FROM supervision_definition_centers dc
      JOIN supervision_definitions d ON d.id = dc.definition_id
      WHERE d.status = 'active' AND dc.center_name = $1 AND d.object_name = $2
      GROUP BY dc.center_name, d.object_name`, [ centerName, objectName ]);
    return result.rows[0] || null;
  }

  async centerObjectPlans(centerName, objectName, client = this.pool) {
    const result = await client.query(`
      SELECT d.id, d.object_name, d.object_category, d.check_layer, d.check_method,
             d.description, d.steps, d.frequency, d.access_mode, d.priority,
             d.reference_result, d.reference_materials,
             ARRAY(SELECT dc2.center_name FROM supervision_definition_centers dc2
               WHERE dc2.definition_id = d.id ORDER BY dc2.center_name) AS centers
      FROM supervision_definitions d
      JOIN supervision_definition_centers dc ON dc.definition_id = d.id
      WHERE d.status = 'active' AND dc.center_name = $1 AND d.object_name = $2
      ORDER BY d.plan_number`, [ centerName, objectName ]);
    return result.rows;
  }

  async listObjectAiJobs() {
    const result = await this.pool.query(`
      SELECT DISTINCT ON (center_name, left_object_name, right_object_name)
             id, center_name, left_object_name, right_object_name, status,
             model_name, prompt_version, result, error_message, duration_ms,
             created_at, completed_at
      FROM ai_supervision_object_dedupe_jobs
      WHERE status IN ('completed', 'failed')
      ORDER BY center_name, left_object_name, right_object_name, created_at DESC`);
    return result.rows;
  }

  async findObjectAiJob(inputHash, modelName, promptVersion, client = this.pool) {
    const result = await client.query(`
      SELECT * FROM ai_supervision_object_dedupe_jobs
      WHERE input_hash = $1 AND model_name IS NOT DISTINCT FROM $2
        AND prompt_version = $3 AND status = 'completed'
      ORDER BY created_at DESC LIMIT 1`, [ inputHash, modelName || null, promptVersion ]);
    return result.rows[0] || null;
  }

  async createObjectAiJob({ centerName, leftObjectName, rightObjectName, inputHash, algorithmVersion, promptVersion, modelName }, client = this.pool) {
    const result = await client.query(`
      INSERT INTO ai_supervision_object_dedupe_jobs
        (center_name, left_object_name, right_object_name, input_hash, algorithm_version,
         prompt_version, model_name, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'running')
      ON CONFLICT (input_hash, model_name, prompt_version)
      DO UPDATE SET status = 'running', error_message = NULL, completed_at = NULL
      RETURNING *`, [
      centerName, leftObjectName, rightObjectName, inputHash, algorithmVersion,
      promptVersion, modelName || null,
    ]);
    return result.rows[0];
  }

  async completeObjectAiJob(id, result, client = this.pool) {
    const query = await client.query(`
      UPDATE ai_supervision_object_dedupe_jobs
      SET status = 'completed', result = $2, provider_status = $3,
          duration_ms = $4, completed_at = now(), error_message = NULL
      WHERE id = $1 RETURNING *`, [
      id, JSON.stringify(result.result), result.providerStatus, result.durationMs,
    ]);
    return query.rows[0];
  }

  async failObjectAiJob(id, error, client = this.pool) {
    const query = await client.query(`
      UPDATE ai_supervision_object_dedupe_jobs
      SET status = 'failed', error_message = $2, provider_status = $3,
          duration_ms = $4, completed_at = now()
      WHERE id = $1 RETURNING *`, [
      id, error.message, error.providerStatus || null, error.durationMs || null,
    ]);
    return query.rows[0];
  }

  async reviewCenterObject({ centerName, leftObjectName, rightObjectName, decision, canonicalObjectName, notes, reviewerId }, client = null) {
    const ownClient = !client;
    const db = client || await this.pool.connect();
    try {
      if (ownClient) await db.query('BEGIN');
      const entries = await db.query(`
        SELECT d.id, d.object_name, d.canonical_object_id, d.plan_number, d.object_category, d.check_layer,
               d.check_method, d.description, d.steps, d.frequency, d.access_mode,
               d.priority, d.reference_result, d.reference_materials, d.normalized_hash,
               ARRAY(SELECT dc2.center_name FROM supervision_definition_centers dc2
                 WHERE dc2.definition_id = d.id ORDER BY dc2.center_name) AS centers
        FROM supervision_definitions d
        JOIN supervision_definition_centers dc ON dc.definition_id = d.id
        WHERE d.status = 'active' AND dc.center_name = $1 AND d.object_name = ANY($2::text[])
        FOR UPDATE OF d`, [ centerName, [ leftObjectName, rightObjectName ] ]);
      const leftPlans = entries.rows.filter(plan => plan.object_name === leftObjectName);
      const rightPlans = entries.rows.filter(plan => plan.object_name === rightObjectName);
      if (!leftPlans.length || !rightPlans.length) {
        const error = new Error('待复核的检查对象已发生变化，请刷新后重试');
        error.code = 'OBJECT_DEDUPE_CANDIDATE_CHANGED';
        throw error;
      }
      let affectedPlanIds = [];
      if (decision === 'merged') {
        const sourceObjectName = canonicalObjectName === leftObjectName ? rightObjectName : leftObjectName;
        if (![ leftObjectName, rightObjectName ].includes(canonicalObjectName)) {
          const error = new Error('保留对象必须是候选对象之一');
          error.code = 'OBJECT_DEDUPE_INVALID_CANONICAL';
          throw error;
        }
        const sourcePlans = entries.rows.filter(plan => plan.object_name === sourceObjectName);
        const canonicalObjectId = entries.rows.find(plan => plan.object_name === canonicalObjectName)?.canonical_object_id;
        if (sourcePlans.some(plan => (plan.centers || []).some(center => center !== centerName))) {
          const error = new Error('待合并对象关联的检查方案还适用于其他机构；为避免跨机构串改，不能在此合并');
          error.code = 'OBJECT_DEDUPE_CROSS_CENTER';
          throw error;
        }
        for (const plan of sourcePlans) {
          await db.query(`
            INSERT INTO supervision_object_aliases (object_id, alias_name, normalized_name, center_name, source)
            VALUES ($1, $2, lower(regexp_replace(btrim($2), '[[:space:][:punct:]]+', '', 'g')), $3, 'dedupe')
            ON CONFLICT DO NOTHING`, [ canonicalObjectId, plan.object_name, centerName ]);
          const fields = {
            object_name: canonicalObjectName,
            object_category: plan.object_category || '',
            check_layer: plan.check_layer || '',
            check_method: plan.check_method || '',
            description: plan.description || '',
            steps: plan.steps || '',
            frequency: plan.frequency || '',
          };
          const normalizedHash = normalizeDefinition(fields).normalizedHash;
          await db.query(`
            UPDATE supervision_definitions
            SET object_name = $2, canonical_object_id = $3, normalized_hash = $4, updated_at = now()
            WHERE id = $1`, [ plan.id, canonicalObjectName, canonicalObjectId, normalizedHash ]);
        }
        affectedPlanIds = sourcePlans.map(plan => plan.id);
      }
      const review = await db.query(`
        INSERT INTO supervision_object_dedupe_reviews
          (center_name, left_object_name, right_object_name, decision,
           canonical_object_name, reviewer_id, notes, affected_plan_ids)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        RETURNING *`, [
        centerName, leftObjectName, rightObjectName, decision,
        canonicalObjectName || null, reviewerId || null, notes || null,
        JSON.stringify(affectedPlanIds),
      ]);
      if (decision === 'merged') {
        await db.query(`
          INSERT INTO audit_logs (actor_user_id, action, entity_type, metadata)
          VALUES ($1, 'merge_center_object', 'supervision_center_object', $2)`, [
          reviewerId || null,
          JSON.stringify({
            centerName,
            sourceObjectName: canonicalObjectName === leftObjectName ? rightObjectName : leftObjectName,
            canonicalObjectName,
            affectedPlanIds,
            reviewId: review.rows[0].id,
          }),
        ]);
      }
      if (ownClient) await db.query('COMMIT');
      return review.rows[0];
    } catch (error) {
      if (ownClient) await db.query('ROLLBACK');
      throw error;
    } finally {
      if (ownClient) db.release();
    }
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

  async searchStandardItems(search = '', limit = 30) {
    const term = String(search || '').trim();
    if (!term) return [];
    const result = await this.pool.query(`
      SELECT si.id, si.item_code AS code, si.standard_number AS "standardNumber", si.title,
             sc.code AS "chapterCode", sc.name AS "chapterName",
             s.code AS "standardCode", sv.version,
             left(si.content, 260) AS preview
      FROM standard_items si
      JOIN standard_versions sv ON sv.id = si.standard_version_id
      JOIN standards s ON s.id = sv.standard_id
      JOIN standard_chapters sc ON sc.id = si.chapter_id
      WHERE si.item_code ILIKE $1 OR si.standard_number ILIKE $1
         OR COALESCE(si.title, '') ILIKE $1 OR si.content ILIKE $1
         OR s.code ILIKE $1 OR sv.version ILIKE $1
      ORDER BY
        CASE WHEN si.standard_number ILIKE $2 OR si.item_code ILIKE $2 THEN 0 ELSE 1 END,
        s.code, sv.version, si.item_code
      LIMIT $3`, [ `%${term}%`, `${term}%`, limit ]);
    return result.rows;
  }

  async listDefinitionFieldOptions() {
    const [ layers, frequencies ] = await Promise.all([
      this.pool.query(`
        SELECT DISTINCT btrim(check_layer) AS value
        FROM supervision_definitions
        WHERE status = 'active' AND btrim(COALESCE(check_layer, '')) <> ''
        ORDER BY value`),
      this.pool.query(`
        SELECT DISTINCT btrim(frequency) AS value
        FROM supervision_definitions
        WHERE status = 'active' AND btrim(COALESCE(frequency, '')) <> ''
        ORDER BY value`),
    ]);
    return {
      checkLayerOptions: layers.rows.map(row => row.value),
      frequencyOptions: frequencies.rows.map(row => row.value),
    };
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
        await this.ensureCanonicalObject(client, fields.objectName, fields.objectCategory, centerName);
        await client.query(`INSERT INTO supervision_definition_centers (definition_id, center_name)
          VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ result.rows[0].id, centerName ]);
      }
      const canonicalObjectId = await this.ensureCanonicalObject(client, fields.objectName, fields.objectCategory);
      await client.query('UPDATE supervision_definitions SET canonical_object_id = $2 WHERE id = $1', [ result.rows[0].id, canonicalObjectId ]);
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
        await this.ensureCanonicalObject(client, fields.objectName, fields.objectCategory, centerName);
        await client.query(`INSERT INTO supervision_definition_centers (definition_id, center_name)
          VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ id, centerName ]);
      }
      const canonicalObjectId = await this.ensureCanonicalObject(client, fields.objectName, fields.objectCategory);
      await client.query('UPDATE supervision_definitions SET canonical_object_id = $2 WHERE id = $1', [ id, canonicalObjectId ]);
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
