'use strict';

class ProjectRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listProjects(userId) {
    const result = await this.pool.query(`
      SELECT p.id, p.name, p.status, p.source_project_id, sp.name AS source_project_name, p.project_manager_id, u.display_name AS project_manager_name,
             count(DISTINCT psv.standard_version_id)::integer AS standard_version_count,
             count(DISTINCT pcc.cloud_center_id)::integer AS cloud_center_count
      FROM projects p
      LEFT JOIN users u ON u.id = p.project_manager_id
      LEFT JOIN projects sp ON sp.id = p.source_project_id
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
      GROUP BY p.id, u.display_name, sp.name
      ORDER BY p.created_at DESC`, [ userId ]);
    return result.rows;
  }

  async listActiveUsers() {
    const result = await this.pool.query(`
      SELECT id, username, display_name FROM users
      WHERE is_active = true ORDER BY display_name, username`);
    return result.rows;
  }

  async createProject({ name, projectManagerId, sourceProjectId }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let source = null;
      if (sourceProjectId) {
        const sourceResult = await client.query('SELECT * FROM projects WHERE id = $1', [ sourceProjectId ]);
        if (!sourceResult.rowCount) {
          const error = new Error('所选来源项目不存在');
          error.code = 'INVALID_SOURCE_PROJECT';
          throw error;
        }
        source = sourceResult.rows[0];
      }
      const created = await client.query(`
        INSERT INTO projects (code, name, project_manager_id, source_project_id)
        VALUES ('PRJ-' || upper(replace(gen_random_uuid()::text, '-', '')), $1, $2, $3) RETURNING *`,
      [ name, projectManagerId || null, sourceProjectId || null ]);
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
      INSERT INTO project_standard_items (project_id, standard_item_id, standard_number_snapshot,
        item_code_snapshot, content_snapshot, chapter_code_snapshot, heading_path_snapshot, snapshotted_at)
      SELECT $2, standard_item_id, standard_number_snapshot, item_code_snapshot,
        content_snapshot, chapter_code_snapshot, heading_path_snapshot, snapshotted_at
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
      SELECT id, standard_item_id, cloud_center_id, applicability, applicability_scope,
             status, actual_evidence, measure_description, problem_description, owner_user_id, updated_at
      FROM project_standard_answers WHERE project_id = $1`, [ sourceProjectId ]);
    const answerMap = new Map();
    for (const answer of answers.rows) {
      const inserted = await client.query(`
        INSERT INTO project_standard_answers
          (project_id, standard_item_id, cloud_center_id, applicability, applicability_scope,
           status, actual_evidence, measure_description, problem_description, owner_user_id, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT DO NOTHING RETURNING id`,
      [ targetProjectId, answer.standard_item_id, answer.cloud_center_id, answer.applicability,
        answer.applicability_scope, answer.status, answer.actual_evidence, answer.measure_description,
        answer.problem_description, answer.owner_user_id, answer.updated_at ]);
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
      SELECT p.*, source_project.name AS source_project_name, u.display_name AS project_manager_name FROM projects p
      LEFT JOIN users u ON u.id = p.project_manager_id
      LEFT JOIN projects source_project ON source_project.id = p.source_project_id
      WHERE p.id = $1`, [ projectId ]);
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
      SELECT psi.standard_item_id, psi.standard_number_snapshot, psi.item_code_snapshot,
             psi.content_snapshot, psi.chapter_code_snapshot, psi.heading_path_snapshot,
             si.title,
             COALESCE(psa.standard_level, '') AS standard_level,
             COALESCE(psa.is_key, false) AS is_key,
             COALESCE(psa.clause_assignment, '') AS clause_assignment,
             COALESCE(psa.unified_requirement, '') AS unified_requirement,
             COALESCE(psa.expected_evidence, '') AS expected_evidence,
             COALESCE(psa.applicability, 'unspecified') AS applicability,
             COALESCE(psa.applicability_scope, '') AS applicability_scope,
             COALESCE(psa.status, 'unassessed') AS answer_status,
             COALESCE(psa.actual_evidence, '') AS actual_evidence,
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

  async updateProjectName(projectId, name) {
    const result = await this.pool.query(`
      UPDATE projects SET name = $2, updated_at = now()
      WHERE id = $1
      RETURNING id, name, status, source_project_id, project_manager_id, updated_at`,
    [ projectId, name ]);
    return result.rows[0] || null;
  }

  async getProjectManageDetail(projectId) {
    const detail = await this.getProjectDetail(projectId);
    if (!detail) return null;
    const members = await this.pool.query(`
      SELECT u.id, u.username, u.display_name, u.is_active,
             COALESCE(json_agg(json_build_object('code', r.code, 'name', r.name) ORDER BY r.code)
               FILTER (WHERE r.code IS NOT NULL), '[]'::json) AS roles,
             bool_or(r.code = 'project_admin') AS is_project_admin
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id AND ur.project_id = $1
      JOIN roles r ON r.id = ur.role_id AND r.scope = 'project'
      GROUP BY u.id
      ORDER BY u.is_active DESC, u.display_name, u.username`, [ projectId ]);
    const availableUsers = await this.pool.query(`
      SELECT id, username, display_name
      FROM users WHERE is_active = true ORDER BY display_name, username`);
    const projectUsers = await this.pool.query(`
      SELECT DISTINCT u.id, u.username, u.display_name
      FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.project_id = $1
      JOIN roles r ON r.id = ur.role_id AND r.scope = 'project'
      WHERE u.is_active = true ORDER BY u.display_name, u.username`, [ projectId ]);
    const chapters = await this.pool.query(`
      SELECT sc.id, sc.code, sc.name, sc.sort_order,
             COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id', u.id, 'username', u.username, 'displayName', u.display_name)
               ORDER BY jsonb_build_object('id', u.id, 'username', u.username, 'displayName', u.display_name)) FILTER (WHERE u.id IS NOT NULL), '[]'::jsonb) AS responsibles
      FROM standard_chapters sc
      LEFT JOIN chapter_responsibilities cr ON cr.project_id = $1 AND cr.chapter_id = sc.id
      LEFT JOIN users u ON u.id = cr.user_id
      WHERE EXISTS (
        SELECT 1 FROM standard_items si
        JOIN project_standard_items psi ON psi.standard_item_id = si.id AND psi.project_id = $1
        WHERE si.chapter_id = sc.id
      )
      GROUP BY sc.id
      ORDER BY sc.sort_order, sc.code`, [ projectId ]);
    const cloudCenters = await this.pool.query('SELECT id, code, name, center_type FROM cloud_centers ORDER BY name, code');
    const projectCloudCenters = await this.pool.query('SELECT cc.id, cc.code, cc.name, cc.center_type, pcc.owner_user_id FROM project_cloud_centers pcc JOIN cloud_centers cc ON cc.id = pcc.cloud_center_id WHERE pcc.project_id = $1 ORDER BY cc.name, cc.code', [ projectId ]);
    const availableStandardVersions = await this.pool.query(`
      SELECT sv.id, sv.version, s.code AS standard_code, s.name AS standard_name,
             count(si.id)::integer AS item_count
      FROM standard_versions sv
      JOIN standards s ON s.id = sv.standard_id
      LEFT JOIN standard_items si ON si.standard_version_id = sv.id
      WHERE NOT EXISTS (
        SELECT 1 FROM project_standard_versions psv
        WHERE psv.project_id = $1 AND psv.standard_version_id = sv.id
      )
      GROUP BY sv.id, sv.version, s.code, s.name
      HAVING count(si.id) > 0
      ORDER BY s.code, s.version`, [ projectId ]);
    return {
      ...detail,
      members: members.rows,
      availableUsers: availableUsers.rows,
      projectUsers: projectUsers.rows,
      chapters: chapters.rows,
      cloudCenters: cloudCenters.rows,
      projectCloudCenters: projectCloudCenters.rows,
      availableStandardVersions: availableStandardVersions.rows,
    };
  }

  async addProjectStandardVersion({ projectId, standardVersionId }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const project = await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [ projectId ]);
      const version = await client.query(`
        SELECT sv.id
        FROM standard_versions sv
        WHERE sv.id = $1
          AND EXISTS (SELECT 1 FROM standard_items si WHERE si.standard_version_id = sv.id)
        FOR UPDATE`, [ standardVersionId ]);
      if (!project.rowCount || !version.rowCount) {
        const error = new Error('项目不存在或所选规范版本没有标准项');
        error.code = 'INVALID_STANDARD_VERSION';
        throw error;
      }
      await client.query(`
        INSERT INTO project_standard_versions (project_id, standard_version_id, snapshot_at)
        VALUES ($1, $2, now())
        ON CONFLICT DO NOTHING`, [ projectId, standardVersionId ]);
      await client.query(`
        INSERT INTO project_standard_items
          (project_id, standard_item_id, standard_number_snapshot, item_code_snapshot,
           content_snapshot, chapter_code_snapshot, heading_path_snapshot, snapshotted_at)
        SELECT $1, si.id, si.standard_number, si.item_code, si.content, sc.code, si.heading_path, now()
        FROM standard_items si
        JOIN standard_chapters sc ON sc.id = si.chapter_id
        WHERE si.standard_version_id = $2
        ON CONFLICT DO NOTHING`, [ projectId, standardVersionId ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceProjectCloudCenters({ projectId, cloudCenterIds, ownerUserId }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM project_cloud_centers WHERE project_id = $1', [ projectId ]);
      for (const cloudCenterId of cloudCenterIds) {
        await client.query('INSERT INTO project_cloud_centers (project_id, cloud_center_id, owner_user_id) SELECT $1, id, $3 FROM cloud_centers WHERE id = $2 ON CONFLICT DO NOTHING', [ projectId, cloudCenterId, ownerUserId || null ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async setProjectMember({ projectId, userId, roleCode }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const project = await client.query('SELECT id FROM projects WHERE id = $1', [ projectId ]);
      const user = await client.query('SELECT id FROM users WHERE id = $1 AND is_active = true', [ userId ]);
      if (!project.rowCount || !user.rowCount) {
        const error = new Error('项目或用户不存在/已停用');
        error.code = 'INVALID_MEMBER';
        throw error;
      }
      if (![ 'project_admin', 'operator' ].includes(roleCode)) {
        const error = new Error('无效的项目角色');
        error.code = 'INVALID_ROLE';
        throw error;
      }
      await client.query(`
        DELETE FROM user_roles ur USING roles r
        WHERE ur.user_id = $1 AND ur.project_id = $2 AND ur.role_id = r.id AND r.scope = 'project'`, [ userId, projectId ]);
      await client.query(`
        INSERT INTO user_roles (user_id, role_id, project_id)
        SELECT $1, id, $2 FROM roles WHERE code = $3 AND scope = 'project'
        ON CONFLICT DO NOTHING`, [ userId, projectId, roleCode ]);
      if (roleCode === 'project_admin') {
        await client.query('UPDATE projects SET project_manager_id = COALESCE(project_manager_id, $2), updated_at = now() WHERE id = $1', [ projectId, userId ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async removeProjectMember(projectId, userId) {
    const project = await this.pool.query('SELECT project_manager_id FROM projects WHERE id = $1', [ projectId ]);
    if (project.rows[0] && project.rows[0].project_manager_id === userId) {
      const error = new Error('请先指定新的项目管理员，再移除当前管理员');
      error.code = 'CURRENT_MANAGER';
      throw error;
    }
    await this.pool.query(`
      DELETE FROM user_roles ur USING roles r
      WHERE ur.user_id = $1 AND ur.project_id = $2 AND ur.role_id = r.id AND r.scope = 'project'`, [ userId, projectId ]);
    await this.pool.query('DELETE FROM chapter_responsibilities WHERE project_id = $1 AND user_id = $2', [ projectId, userId ]);
  }

  async setProjectManager(projectId, userId) {
    const user = await this.pool.query('SELECT id FROM users WHERE id = $1 AND is_active = true', [ userId ]);
    if (!user.rowCount) {
      const error = new Error('项目管理员不存在或已停用');
      error.code = 'INVALID_MANAGER';
      throw error;
    }
    const result = await this.pool.query(`
      UPDATE projects SET project_manager_id = $2, updated_at = now() WHERE id = $1 RETURNING id`, [ projectId, userId || null ]);
    if (!result.rowCount) return null;
    if (userId) {
      await this.pool.query(`
        INSERT INTO user_roles (user_id, role_id, project_id)
        SELECT $2, id, $1 FROM roles WHERE code = 'project_admin'
        ON CONFLICT DO NOTHING`, [ projectId, userId ]);
    }
    return result.rows[0];
  }

  async replaceChapterResponsibilities({ projectId, chapterId, userIds, assignedBy }) {
    const chapter = await this.pool.query(`
      SELECT sc.id FROM standard_chapters sc
      JOIN standard_items si ON si.chapter_id = sc.id
      JOIN project_standard_items psi ON psi.standard_item_id = si.id AND psi.project_id = $1
      WHERE sc.id = $2 LIMIT 1`, [ projectId, chapterId ]);
    if (!chapter.rowCount) {
      const error = new Error('该章节不属于当前项目基线');
      error.code = 'INVALID_CHAPTER';
      throw error;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM chapter_responsibilities WHERE project_id = $1 AND chapter_id = $2', [ projectId, chapterId ]);
      for (const userId of userIds) {
        await client.query(`
          INSERT INTO chapter_responsibilities (project_id, chapter_id, user_id, assigned_by)
          SELECT $1, $2, u.id, $4 FROM users u
          WHERE u.id = $3 AND u.is_active = true
            AND EXISTS (
              SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id AND ur.project_id = $1 AND r.scope = 'project'
            )
          ON CONFLICT DO NOTHING`, [ projectId, chapterId, userId, assignedBy ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveAnswer({ projectId, standardItemId, standardLevel, isKey, clauseAssignment, unifiedRequirement, expectedEvidence, applicability, applicabilityScope, status, actualEvidence, measureDescription, problemDescription, ownerUserId }) {
    const result = await this.pool.query(`
      INSERT INTO project_standard_answers
        (project_id, standard_item_id, standard_level, is_key, clause_assignment, unified_requirement,
         expected_evidence, applicability, applicability_scope, status, actual_evidence,
         measure_description, problem_description, owner_user_id, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
      ON CONFLICT (project_id, standard_item_id) WHERE cloud_center_id IS NULL DO UPDATE SET
        standard_level = EXCLUDED.standard_level, is_key = EXCLUDED.is_key,
        clause_assignment = EXCLUDED.clause_assignment, unified_requirement = EXCLUDED.unified_requirement,
        expected_evidence = EXCLUDED.expected_evidence,
        applicability = EXCLUDED.applicability, applicability_scope = EXCLUDED.applicability_scope,
        status = EXCLUDED.status, actual_evidence = EXCLUDED.actual_evidence,
        measure_description = EXCLUDED.measure_description,
        problem_description = EXCLUDED.problem_description, owner_user_id = EXCLUDED.owner_user_id,
        updated_at = now()
      RETURNING *`, [
      projectId, standardItemId, standardLevel || null, isKey === true,
      clauseAssignment || null, unifiedRequirement || null, expectedEvidence || null,
      applicability, applicabilityScope || null, status, actualEvidence || null,
      measureDescription || null, problemDescription || null, ownerUserId || null,
    ]);
    return result.rows[0];
  }
}

module.exports = ProjectRepository;
