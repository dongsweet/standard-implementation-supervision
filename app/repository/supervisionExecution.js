'use strict';

class SupervisionExecutionRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listOptions(projectId) {
    const definitions = await this.pool.query(`
      SELECT d.id, d.object_name, d.check_method, d.frequency,
             COALESCE(json_agg(json_build_object(
               'id', si.id, 'code', si.item_code, 'title', si.title
             ) ORDER BY si.item_code) FILTER (WHERE si.id IS NOT NULL), '[]'::json) AS standard_items
      FROM supervision_definitions d
      LEFT JOIN supervision_definition_standard_items dsi ON dsi.definition_id = d.id
      LEFT JOIN standard_items si ON si.id = dsi.standard_item_id
      WHERE d.status = 'active'
      GROUP BY d.id
      ORDER BY d.object_name, d.check_method`);
    const cloudCenters = await this.pool.query(`
      SELECT cc.id, cc.code, cc.name, cc.center_type
      FROM project_cloud_centers pcc JOIN cloud_centers cc ON cc.id = pcc.cloud_center_id
      WHERE pcc.project_id = $1
      ORDER BY cc.name, cc.code`, [ projectId ]);
    return { definitions: definitions.rows, cloudCenters: cloudCenters.rows };
  }

  async list(projectId) {
    const result = await this.pool.query(`
      SELECT e.id, e.checked_at, e.overall_result, e.notes,
             d.object_name, d.check_method,
             cc.name AS cloud_center_name,
             u.display_name AS checked_by_name,
             count(sir.id)::integer AS item_result_count,
             count(sir.id) FILTER (WHERE sir.result = 'satisfied')::integer AS satisfied_count
      FROM supervision_executions e
      JOIN supervision_definitions d ON d.id = e.definition_id
      LEFT JOIN cloud_centers cc ON cc.id = e.cloud_center_id
      LEFT JOIN users u ON u.id = e.checked_by
      LEFT JOIN supervision_item_results sir ON sir.execution_id = e.id
      WHERE e.project_id = $1
      GROUP BY e.id, d.id, cc.id, u.id
      ORDER BY e.checked_at DESC, e.created_at DESC`, [ projectId ]);
    return result.rows;
  }

  async create({ projectId, definitionId, cloudCenterId, checkedAt, checkedBy, overallResult, notes, itemResults }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const definition = await client.query(`
        SELECT si.id
        FROM supervision_definitions d
        JOIN supervision_definition_standard_items dsi ON dsi.definition_id = d.id
        JOIN standard_items si ON si.id = dsi.standard_item_id
        WHERE d.id = $1 AND d.status = 'active'
        ORDER BY si.item_code`, [ definitionId ]);
      if (!definition.rowCount) {
        const error = new Error('监督定义不存在、已归并或未关联标准项');
        error.code = 'INVALID_DEFINITION';
        throw error;
      }
      if (cloudCenterId) {
        const center = await client.query('SELECT 1 FROM project_cloud_centers WHERE project_id = $1 AND cloud_center_id = $2', [ projectId, cloudCenterId ]);
        if (!center.rowCount) {
          const error = new Error('所选云中心未纳入当前项目');
          error.code = 'INVALID_CLOUD_CENTER';
          throw error;
        }
      }
      const execution = await client.query(`
        INSERT INTO supervision_executions
          (project_id, cloud_center_id, definition_id, checked_at, checked_by, overall_result, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id`, [ projectId, cloudCenterId || null, definitionId, checkedAt, checkedBy, overallResult || null, notes || null ]);
      for (const standardItemId of definition.rows.map(row => row.id)) {
        const item = itemResults.get(standardItemId) || {};
        await client.query(`
          INSERT INTO supervision_item_results
            (execution_id, standard_item_id, result, description, problem_description, rectification_due_at)
          VALUES ($1, $2, $3, $4, $5, $6)`, [
          execution.rows[0].id, standardItemId, item.result || 'unassessed',
          item.description || null, item.problemDescription || null, item.rectificationDueAt || null,
        ]);
      }
      await client.query('COMMIT');
      return execution.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = SupervisionExecutionRepository;
