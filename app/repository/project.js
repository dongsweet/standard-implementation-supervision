'use strict';

class ProjectRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listProjects() {
    const result = await this.pool.query(`
      SELECT p.id, p.code, p.name, p.status, p.project_manager_id, u.display_name AS project_manager_name,
             count(DISTINCT psv.standard_version_id)::integer AS standard_version_count,
             count(DISTINCT pcc.cloud_center_id)::integer AS cloud_center_count
      FROM projects p
      LEFT JOIN users u ON u.id = p.project_manager_id
      LEFT JOIN project_standard_versions psv ON psv.project_id = p.id
      LEFT JOIN project_cloud_centers pcc ON pcc.project_id = p.id
      GROUP BY p.id, u.display_name
      ORDER BY p.created_at DESC`);
    return result.rows;
  }

  async listPublishedVersions() {
    const result = await this.pool.query(`
      SELECT sv.id, sv.version, sv.standard_id, s.code AS standard_code, s.name AS standard_name,
             count(si.id)::integer AS item_count
      FROM standard_versions sv JOIN standards s ON s.id = sv.standard_id
      LEFT JOIN standard_items si ON si.standard_version_id = sv.id
      WHERE sv.status = 'published'
      GROUP BY sv.id, s.id
      ORDER BY s.code, sv.created_at DESC`);
    return result.rows;
  }

  async createProject({ code, name, projectManagerId }) {
    const result = await this.pool.query(`
      INSERT INTO projects (code, name, project_manager_id) VALUES ($1, $2, $3) RETURNING *`, [ code, name, projectManagerId || null ]);
    return result.rows[0];
  }

  async getProjectDetail(projectId) {
    const projectResult = await this.pool.query(`
      SELECT p.*, u.display_name AS project_manager_name FROM projects p
      LEFT JOIN users u ON u.id = p.project_manager_id WHERE p.id = $1`, [ projectId ]);
    if (!projectResult.rowCount) return null;
    const versions = await this.pool.query(`
      SELECT psv.snapshot_at, sv.id, sv.version, s.code AS standard_code, s.name AS standard_name,
             count(psi.standard_item_id)::integer AS item_count
      FROM project_standard_versions psv
      JOIN standard_versions sv ON sv.id = psv.standard_version_id
      JOIN standards s ON s.id = sv.standard_id
      LEFT JOIN project_standard_items psi ON psi.project_id = psv.project_id AND psi.standard_item_id IN (SELECT id FROM standard_items WHERE standard_version_id = sv.id)
      WHERE psv.project_id = $1
      GROUP BY psv.project_id, psv.snapshot_at, sv.id, s.id
      ORDER BY s.code, sv.version`, [ projectId ]);
    const items = await this.pool.query(`
      SELECT psi.standard_item_id, psi.item_code_snapshot, psi.content_snapshot, psi.chapter_code_snapshot,
             si.title, si.level, si.is_key,
             COALESCE(psa.status, 'unassessed') AS answer_status,
             COALESCE(psa.measure_description, '') AS measure_description,
             COALESCE(psa.problem_description, '') AS problem_description,
             psa.updated_at AS answer_updated_at
      FROM project_standard_items psi
      JOIN standard_items si ON si.id = psi.standard_item_id
      LEFT JOIN project_standard_answers psa ON psa.project_id = psi.project_id
        AND psa.standard_item_id = psi.standard_item_id AND psa.cloud_center_id IS NULL
      WHERE psi.project_id = $1
      ORDER BY psi.chapter_code_snapshot, psi.item_code_snapshot`, [ projectId ]);
    return { project: projectResult.rows[0], versions: versions.rows, items: items.rows };
  }

  async attachVersion(projectId, versionId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const version = await client.query(`SELECT id FROM standard_versions WHERE id = $1 AND status = 'published'`, [ versionId ]);
      if (!version.rowCount) {
        const error = new Error('只能关联已发布规范版本');
        error.code = 'VERSION_NOT_PUBLISHED';
        throw error;
      }
      await client.query(`INSERT INTO project_standard_versions (project_id, standard_version_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ projectId, versionId ]);
      const inserted = await client.query(`
        INSERT INTO project_standard_items (project_id, standard_item_id, item_code_snapshot, content_snapshot, chapter_code_snapshot)
        SELECT $1, si.id, si.item_code, si.content, sc.code
        FROM standard_items si JOIN standard_chapters sc ON sc.id = si.chapter_id
        WHERE si.standard_version_id = $2
        ON CONFLICT DO NOTHING`, [ projectId, versionId ]);
      await client.query('COMMIT');
      return inserted.rowCount;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveAnswer({ projectId, standardItemId, status, measureDescription, problemDescription, ownerUserId }) {
    const result = await this.pool.query(`
      INSERT INTO project_standard_answers
        (project_id, standard_item_id, status, measure_description, problem_description, owner_user_id, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (project_id, standard_item_id) WHERE cloud_center_id IS NULL DO UPDATE SET
        status = EXCLUDED.status, measure_description = EXCLUDED.measure_description,
        problem_description = EXCLUDED.problem_description, owner_user_id = EXCLUDED.owner_user_id,
        updated_at = now()
      RETURNING *`, [ projectId, standardItemId, status, measureDescription || null, problemDescription || null, ownerUserId || null ]);
    return result.rows[0];
  }
}

module.exports = ProjectRepository;
