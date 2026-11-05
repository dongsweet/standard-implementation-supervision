'use strict';

class ProjectRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listProjects(userId) {
    const result = await this.pool.query(`
      SELECT p.id, p.code, p.name, p.status, p.is_template, p.source_project_id, p.project_manager_id, u.display_name AS project_manager_name,
             count(DISTINCT psv.standard_version_id)::integer AS standard_version_count,
             count(DISTINCT pcc.cloud_center_id)::integer AS cloud_center_count
      FROM projects p
      LEFT JOIN users u ON u.id = p.project_manager_id
      LEFT JOIN project_standard_versions psv ON psv.project_id = p.id
      LEFT JOIN project_cloud_centers pcc ON pcc.project_id = p.id
      WHERE EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND ur.project_id IS NULL
          AND r.code IN ('system_admin', 'audit_admin', 'security_admin')
      ) OR EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND ur.project_id = p.id
          AND r.code IN ('project_admin', 'operator')
      ) OR p.project_manager_id = $1
      GROUP BY p.id, u.display_name
      ORDER BY p.is_template DESC, p.created_at DESC`, [ userId ]);
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

  async createProject({ code, name, projectManagerId, sourceProjectId, isTemplate }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let source = null;
      if (sourceProjectId) {
        const sourceResult = await client.query(`SELECT * FROM projects WHERE id = $1 AND is_template = true`, [ sourceProjectId ]);
        if (!sourceResult.rowCount) {
          const error = new Error('只能从已标记为模板的项目派生');
          error.code = 'INVALID_TEMPLATE';
          throw error;
        }
        source = sourceResult.rows[0];
      }
      const created = await client.query(`
        INSERT INTO projects (code, name, project_manager_id, is_template, source_project_id)
        VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [ code, name, projectManagerId || null, isTemplate === true, sourceProjectId || null ]);
      const project = created.rows[0];
      if (source) await this.cloneProjectContents(client, source.id, project.id);
      if (projectManagerId) {
        await client.query(`
          INSERT INTO user_roles (user_id, role_id, project_id)
          SELECT $1, id, $2 FROM roles WHERE code = 'project_admin'
          ON CONFLICT DO NOTHING`, [ projectManagerId, project.id ]);
      }
      await client.query('COMMIT');
      return project;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cloneProjectContents(client, sourceProjectId, targetProjectId) {
    await client.query(`
      INSERT INTO project_standard_versions (project_id, standard_version_id, snapshot_at)
      SELECT $2, standard_version_id, snapshot_at FROM project_standard_versions
      WHERE project_id = $1 ON CONFLICT DO NOTHING`, [ sourceProjectId, targetProjectId ]);
    await client.query(`
      INSERT INTO project_standard_items (project_id, standard_item_id, item_code_snapshot, content_snapshot, chapter_code_snapshot, snapshotted_at)
      SELECT $2, standard_item_id, item_code_snapshot, content_snapshot, chapter_code_snapshot, snapshotted_at
      FROM project_standard_items WHERE project_id = $1 ON CONFLICT DO NOTHING`, [ sourceProjectId, targetProjectId ]);
    await client.query(`
      INSERT INTO project_cloud_centers (project_id, cloud_center_id, owner_user_id)
      SELECT $2, cloud_center_id, owner_user_id FROM project_cloud_centers
      WHERE project_id = $1 ON CONFLICT DO NOTHING`, [ sourceProjectId, targetProjectId ]);
    await client.query(`
      INSERT INTO chapter_responsibilities (project_id, chapter_id, user_id, assigned_by, created_at)
      SELECT $2, chapter_id, user_id, assigned_by, created_at FROM chapter_responsibilities
      WHERE project_id = $1 ON CONFLICT DO NOTHING`, [ sourceProjectId, targetProjectId ]);
    await client.query(`
      INSERT INTO user_roles (user_id, role_id, project_id, created_at)
      SELECT user_id, role_id, $2, created_at FROM user_roles
      WHERE project_id = $1 ON CONFLICT DO NOTHING`, [ sourceProjectId, targetProjectId ]);

    const answers = await client.query(`
      SELECT id, standard_item_id, cloud_center_id, status, measure_description,
             problem_description, owner_user_id, updated_at
      FROM project_standard_answers WHERE project_id = $1`, [ sourceProjectId ]);
    const answerMap = new Map();
    for (const answer of answers.rows) {
      const inserted = await client.query(`
        INSERT INTO project_standard_answers
          (project_id, standard_item_id, cloud_center_id, status, measure_description, problem_description, owner_user_id, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT DO NOTHING RETURNING id`,
      [ targetProjectId, answer.standard_item_id, answer.cloud_center_id, answer.status, answer.measure_description, answer.problem_description, answer.owner_user_id, answer.updated_at ]);
      if (inserted.rowCount) answerMap.set(answer.id, inserted.rows[0].id);
    }

    const evidences = await client.query(`
      SELECT id, code, name, storage_key, source_url, content_hash, metadata, created_by, created_at
      FROM evidence_materials WHERE project_id = $1`, [ sourceProjectId ]);
    const evidenceMap = new Map();
    for (const evidence of evidences.rows) {
      const inserted = await client.query(`
        INSERT INTO evidence_materials
          (project_id, code, name, storage_key, source_url, content_hash, metadata, created_by, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [ targetProjectId, evidence.code, evidence.name, evidence.storage_key, evidence.source_url, evidence.content_hash, evidence.metadata, evidence.created_by, evidence.created_at ]);
      evidenceMap.set(evidence.id, inserted.rows[0].id);
    }
    const links = await client.query(`
      SELECT ae.answer_id, ae.evidence_id
      FROM answer_evidence ae JOIN project_standard_answers a ON a.id = ae.answer_id
      WHERE a.project_id = $1`, [ sourceProjectId ]);
    for (const link of links.rows) {
      if (answerMap.has(link.answer_id) && evidenceMap.has(link.evidence_id)) {
        await client.query('INSERT INTO answer_evidence (answer_id, evidence_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ answerMap.get(link.answer_id), evidenceMap.get(link.evidence_id) ]);
      }
    }
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
