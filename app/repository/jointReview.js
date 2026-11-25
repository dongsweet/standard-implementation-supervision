'use strict';

class JointReviewRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listDefinitionContexts({ definitionId = '', objectId = '', standardItemId = '', projectId = '' } = {}) {
    const conditions = [ `d.status = 'active'` ];
    const values = [];
    if (definitionId) {
      values.push(definitionId);
      conditions.push(`d.id = $${values.length}`);
    }
    if (objectId) {
      values.push(objectId);
      conditions.push(`d.canonical_object_id = $${values.length}`);
    }
    if (standardItemId) {
      values.push(standardItemId);
      conditions.push(`EXISTS (SELECT 1 FROM supervision_definition_standard_items filter_dsi
        WHERE filter_dsi.definition_id = d.id AND filter_dsi.standard_item_id = $${values.length})`);
    }
    if (projectId) {
      values.push(projectId);
      conditions.push(`EXISTS (SELECT 1 FROM project_standard_items filter_psi
        JOIN supervision_definition_standard_items filter_dsi2
          ON filter_dsi2.standard_item_id = filter_psi.standard_item_id
        WHERE filter_psi.project_id = $${values.length} AND filter_dsi2.definition_id = d.id)`);
    }
    const result = await this.pool.query(`
      SELECT d.id, d.plan_number, d.object_name, d.object_category, d.check_layer,
             d.check_method, d.description, d.steps, d.frequency, d.access_mode,
             d.priority, d.canonical_object_id AS object_id,
             o.canonical_name AS master_object_name, c.name AS master_category,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'id', si.id, 'code', si.item_code, 'standardNumber', si.standard_number,
                 'title', si.title, 'content', si.content, 'explanation', si.explanation
               ) ORDER BY s.code, sv.version, si.item_code)
               FROM supervision_definition_standard_items dsi
               JOIN standard_items si ON si.id = dsi.standard_item_id
               JOIN standard_versions sv ON sv.id = si.standard_version_id
               JOIN standards s ON s.id = sv.standard_id
               WHERE dsi.definition_id = d.id
             ), '[]'::jsonb) AS standard_items,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'id', psa.id, 'projectId', p.id, 'projectName', p.name,
                 'standardItemId', psa.standard_item_id, 'status', psa.status,
                 'applicability', psa.applicability, 'clauseAssignment', psa.clause_assignment,
                 'assignmentDetails', psa.assignment_details,
                 'complianceDescription', left(psa.compliance_description, 1200),
                 'actualEvidence', left(psa.actual_evidence, 1200)
               ) ORDER BY p.name, psa.standard_item_id)
               FROM project_standard_answers psa
               JOIN projects p ON p.id = psa.project_id
               WHERE psa.standard_item_id IN (
                 SELECT dsi2.standard_item_id FROM supervision_definition_standard_items dsi2
                 WHERE dsi2.definition_id = d.id
               )
             ), '[]'::jsonb) AS project_answers,
             COALESCE((
               SELECT array_agg(dc.center_name ORDER BY dc.center_name)
               FROM supervision_definition_centers dc WHERE dc.definition_id = d.id
             ), ARRAY[]::varchar[]) AS centers
      FROM supervision_definitions d
      LEFT JOIN supervision_objects o ON o.id = d.canonical_object_id
      LEFT JOIN supervision_object_categories c ON c.id = o.category_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY d.plan_number
      LIMIT 2000`, values);
    return result.rows;
  }

  async listObjectContexts({ objectId = '' } = {}) {
    const values = [];
    const conditions = [ `o.status = 'active'` ];
    if (objectId) {
      values.push(objectId);
      conditions.push(`o.id = $${values.length}`);
    }
    const result = await this.pool.query(`
      SELECT o.id, o.canonical_name, c.name AS master_category,
             COALESCE(array_agg(DISTINCT NULLIF(btrim(d.object_category), ''))
               FILTER (WHERE d.id IS NOT NULL), ARRAY[]::text[]) AS plan_categories,
             count(DISTINCT d.id)::integer AS plan_count
      FROM supervision_objects o
      LEFT JOIN supervision_object_categories c ON c.id = o.category_id
      LEFT JOIN supervision_definitions d ON d.canonical_object_id = o.id AND d.status = 'active'
      WHERE ${conditions.join(' AND ')}
      GROUP BY o.id, c.name
      ORDER BY o.canonical_name
      LIMIT 1000`, values);
    return result.rows;
  }

  async listCoverageContexts({ projectId = '', standardItemId = '' } = {}) {
    const values = [];
    const conditions = [ `psa.applicability = 'applicable'` ];
    if (projectId) {
      values.push(projectId);
      conditions.push(`p.id = $${values.length}`);
    }
    if (standardItemId) {
      values.push(standardItemId);
      conditions.push(`si.id = $${values.length}`);
    }
    const result = await this.pool.query(`
      SELECT p.id AS project_id, p.name AS project_name,
             si.id AS standard_item_id, si.item_code, si.standard_number, si.title, si.content,
             psa.status, psa.applicability, psa.clause_assignment, psa.assignment_details,
             psa.compliance_description, psa.actual_evidence,
             count(DISTINCT d.id)::integer AS linked_plan_count,
             COALESCE(array_agg(DISTINCT d.plan_number ORDER BY d.plan_number)
               FILTER (WHERE d.id IS NOT NULL), ARRAY[]::bigint[]) AS plan_numbers
      FROM project_standard_answers psa
      JOIN projects p ON p.id = psa.project_id
      JOIN standard_items si ON si.id = psa.standard_item_id
      LEFT JOIN supervision_definition_standard_items dsi ON dsi.standard_item_id = si.id
      LEFT JOIN supervision_definitions d ON d.id = dsi.definition_id AND d.status = 'active'
      WHERE ${conditions.join(' AND ')}
      GROUP BY p.id, p.name, si.id, psa.id
      ORDER BY p.name, si.standard_number
      LIMIT 2000`, values);
    return result.rows;
  }

  async upsertCandidates(candidates) {
    if (!candidates.length) return { inserted: 0, updated: 0 };
    const client = await this.pool.connect();
    let inserted = 0;
    let updated = 0;
    try {
      await client.query('BEGIN');
      for (const candidate of candidates) {
        const result = await client.query(`
          INSERT INTO supervision_joint_reviews
            (review_type, severity, fingerprint, context_hash, standard_item_id, project_id,
             definition_id, object_id, title, summary, rule_reason, context)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (fingerprint) DO UPDATE SET
            severity = EXCLUDED.severity,
            context_hash = EXCLUDED.context_hash,
            standard_item_id = EXCLUDED.standard_item_id,
            project_id = EXCLUDED.project_id,
            definition_id = EXCLUDED.definition_id,
            object_id = EXCLUDED.object_id,
            title = EXCLUDED.title,
            summary = EXCLUDED.summary,
            rule_reason = EXCLUDED.rule_reason,
            context = EXCLUDED.context,
            ai_status = CASE
              WHEN supervision_joint_reviews.context_hash = EXCLUDED.context_hash
                THEN supervision_joint_reviews.ai_status
              ELSE 'pending'
            END,
            ai_result = CASE
              WHEN supervision_joint_reviews.context_hash = EXCLUDED.context_hash
                THEN supervision_joint_reviews.ai_result
              ELSE NULL
            END,
            ai_error = CASE
              WHEN supervision_joint_reviews.context_hash = EXCLUDED.context_hash
                THEN supervision_joint_reviews.ai_error
              ELSE NULL
            END,
            updated_at = now()
          RETURNING (xmax = 0) AS inserted`, [
          candidate.reviewType, candidate.severity, candidate.fingerprint,
          candidate.contextHash, candidate.standardItemId || null, candidate.projectId || null,
          candidate.definitionId || null, candidate.objectId || null, candidate.title,
          candidate.summary, candidate.ruleReason || null, JSON.stringify(candidate.context || {}),
        ]);
        if (result.rows[0]?.inserted) inserted += 1;
        else updated += 1;
      }
      await client.query('COMMIT');
      return { inserted, updated };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listReviews({ reviewType = '', humanDecision = '', definitionId = '', objectId = '', standardItemId = '' } = {}) {
    const conditions = [];
    const values = [];
    if (reviewType) {
      values.push(reviewType);
      conditions.push(`r.review_type = $${values.length}`);
    }
    if (humanDecision === 'pending') {
      conditions.push(`r.human_decision IS NULL`);
    } else if (humanDecision) {
      values.push(humanDecision);
      conditions.push(`r.human_decision = $${values.length}`);
    }
    for (const [ field, value ] of [ [ 'definition_id', definitionId ], [ 'object_id', objectId ], [ 'standard_item_id', standardItemId ] ]) {
      if (value) {
        values.push(value);
        conditions.push(`r.${field} = $${values.length}`);
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(`
      SELECT r.*, d.plan_number, d.object_name,
             si.standard_number, si.item_code, si.title AS standard_title,
             p.name AS project_name, o.canonical_name AS object_name_master
      FROM supervision_joint_reviews r
      LEFT JOIN supervision_definitions d ON d.id = r.definition_id
      LEFT JOIN standard_items si ON si.id = r.standard_item_id
      LEFT JOIN projects p ON p.id = r.project_id
      LEFT JOIN supervision_objects o ON o.id = r.object_id
      ${where}
      ORDER BY CASE r.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
               r.updated_at DESC
      LIMIT 1000`, values);
    return result.rows;
  }

  async findById(id) {
    const result = await this.pool.query(`
      SELECT r.*, d.plan_number, d.object_name, si.standard_number, si.item_code,
             p.name AS project_name, o.canonical_name AS object_name_master
      FROM supervision_joint_reviews r
      LEFT JOIN supervision_definitions d ON d.id = r.definition_id
      LEFT JOIN standard_items si ON si.id = r.standard_item_id
      LEFT JOIN projects p ON p.id = r.project_id
      LEFT JOIN supervision_objects o ON o.id = r.object_id
      WHERE r.id = $1`, [ id ]);
    return result.rows[0] || null;
  }

  async saveAiResult(id, { result, model, promptVersion, inputHash }) {
    const query = await this.pool.query(`
      UPDATE supervision_joint_reviews
      SET ai_status = 'completed', ai_result = $2, ai_model = $3, prompt_version = $4,
          ai_input_hash = $5, ai_error = NULL, ai_reviewed_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`, [ id, JSON.stringify(result), model || null, promptVersion, inputHash ]);
    return query.rows[0] || null;
  }

  async saveAiError(id, error) {
    const query = await this.pool.query(`
      UPDATE supervision_joint_reviews
      SET ai_status = 'failed', ai_error = $2, updated_at = now()
      WHERE id = $1 RETURNING *`, [ id, error.message ]);
    return query.rows[0] || null;
  }

  async saveHumanDecision(id, { decision, notes, reviewerId }) {
    const query = await this.pool.query(`
      UPDATE supervision_joint_reviews
      SET human_decision = $2, human_notes = $3, reviewer_id = $4,
          reviewed_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`, [ id, decision, notes || null, reviewerId || null ]);
    return query.rows[0] || null;
  }
}

module.exports = JointReviewRepository;
