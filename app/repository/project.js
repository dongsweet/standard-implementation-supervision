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
        item_code_snapshot, title_snapshot, explanation_snapshot, content_snapshot, chapter_code_snapshot, heading_path_snapshot, snapshotted_at)
      SELECT $2, standard_item_id, standard_number_snapshot, item_code_snapshot, title_snapshot,
        explanation_snapshot, content_snapshot, chapter_code_snapshot, heading_path_snapshot, snapshotted_at
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
      SELECT id, standard_item_id, cloud_center_id, applicability,
             status, actual_evidence, answer_notes, owner_user_id,
             is_key, clause_assignment, assignment_details,
             compliance_description, expected_evidence, pending_evidence, responsible_text, updated_at
      FROM project_standard_answers WHERE project_id = $1`, [ sourceProjectId ]);
    const answerMap = new Map();
    for (const answer of answers.rows) {
      const inserted = await client.query(`
        INSERT INTO project_standard_answers
          (project_id, standard_item_id, cloud_center_id, applicability,
           status, actual_evidence, answer_notes, owner_user_id,
           is_key, clause_assignment, assignment_details,
           compliance_description, expected_evidence, pending_evidence, responsible_text, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16)
        ON CONFLICT DO NOTHING RETURNING id`,
      [ targetProjectId, answer.standard_item_id, answer.cloud_center_id, answer.applicability,
        answer.status, answer.actual_evidence,
        answer.answer_notes, answer.owner_user_id,
        answer.is_key, answer.clause_assignment, JSON.stringify(answer.assignment_details || []),
        answer.compliance_description, answer.expected_evidence, answer.pending_evidence, answer.responsible_text,
        answer.updated_at ]);
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
             count(psi.standard_item_id)::integer AS item_count,
             count(DISTINCT psa.standard_item_id) FILTER (WHERE psa.id IS NOT NULL)::integer AS answered_count,
             count(DISTINCT psa.standard_item_id) FILTER (WHERE psa.status = 'satisfied')::integer AS satisfied_count,
             count(DISTINCT psa.standard_item_id) FILTER (WHERE psa.status = 'partially_satisfied')::integer AS partially_satisfied_count,
             count(DISTINCT psa.standard_item_id) FILTER (WHERE psa.status = 'not_satisfied')::integer AS not_satisfied_count
      FROM project_standard_versions psv
      JOIN standard_versions sv ON sv.id = psv.standard_version_id
      JOIN standards s ON s.id = sv.standard_id
      LEFT JOIN project_standard_items psi ON psi.project_id = psv.project_id AND psi.standard_item_id IN (SELECT id FROM standard_items WHERE standard_version_id = sv.id)
      LEFT JOIN project_standard_answers psa ON psa.project_id = psv.project_id
        AND psa.standard_item_id = psi.standard_item_id AND psa.cloud_center_id IS NULL
      WHERE psv.project_id = $1
      GROUP BY psv.project_id, psv.snapshot_at, sv.id, s.id
      ORDER BY s.code, sv.version`, [ projectId ]);
    return { project: projectResult.rows[0], versions: versions.rows, items: [] };
  }

  async getProjectAnswerOverview(projectId) {
    const projectResult = await this.pool.query(`
      SELECT id, name FROM projects WHERE id = $1`, [ projectId ]);
    if (!projectResult.rowCount) return null;
    const versions = await this.pool.query(`
      SELECT sv.id AS standard_version_id, sv.version, s.code AS standard_code,
             s.name AS standard_name, s.standard_type,
             count(psi.standard_item_id)::integer AS item_count,
             count(DISTINCT psa.standard_item_id) FILTER (WHERE psa.id IS NOT NULL)::integer AS answered_count,
             count(DISTINCT psa.standard_item_id) FILTER (WHERE psa.status = 'satisfied')::integer AS satisfied_count,
             count(DISTINCT psa.standard_item_id) FILTER (WHERE psa.status = 'partially_satisfied')::integer AS partially_satisfied_count,
             count(DISTINCT psa.standard_item_id) FILTER (WHERE psa.status = 'not_satisfied')::integer AS not_satisfied_count
      FROM project_standard_versions psv
      JOIN standard_versions sv ON sv.id = psv.standard_version_id
      JOIN standards s ON s.id = sv.standard_id
      LEFT JOIN project_standard_items psi ON psi.project_id = psv.project_id
        AND psi.standard_item_id IN (SELECT id FROM standard_items WHERE standard_version_id = sv.id)
      LEFT JOIN project_standard_answers psa ON psa.project_id = psv.project_id
        AND psa.standard_item_id = psi.standard_item_id AND psa.cloud_center_id IS NULL
      WHERE psv.project_id = $1
      GROUP BY sv.id, s.id
      ORDER BY s.code, sv.version`, [ projectId ]);
    return { project: projectResult.rows[0], standards: versions.rows };
  }

  async getProjectStandardAnswers({ projectId, standardVersionId, search = '', chapterCode = '', status = '', sortBy = 'standardNumber', sortDirection = 'asc', chapterPage = 1, chapterPageSize = '1' }) {
    const versionResult = await this.pool.query(`
      SELECT sv.id AS standard_version_id, sv.version, s.code AS standard_code,
             s.name AS standard_name, s.standard_type, p.name AS project_name
      FROM project_standard_versions psv
      JOIN standard_versions sv ON sv.id = psv.standard_version_id
      JOIN standards s ON s.id = sv.standard_id
      JOIN projects p ON p.id = psv.project_id
      WHERE psv.project_id = $1 AND psv.standard_version_id = $2`, [ projectId, standardVersionId ]);
    if (!versionResult.rowCount) return null;
    const validSorts = {
      standardNumber: 'psi.standard_number_snapshot',
      itemCode: 'psi.item_code_snapshot',
      chapter: 'psi.chapter_code_snapshot',
      status: "COALESCE(psa.status, 'unassessed')",
    };
    const orderBy = validSorts[sortBy] || validSorts.standardNumber;
    const direction = sortDirection === 'desc' ? 'DESC' : 'ASC';
    const chapterOptionsResult = await this.pool.query(`
      SELECT DISTINCT psi.chapter_code_snapshot AS code,
             COALESCE(sc.name, psi.chapter_code_snapshot) AS name,
             COALESCE(sc.sort_order, 0) AS sort_order
      FROM project_standard_items psi
      JOIN standard_items si ON si.id = psi.standard_item_id
      LEFT JOIN standard_chapters sc ON sc.id = si.chapter_id
      WHERE psi.project_id = $1 AND si.standard_version_id = $2
      ORDER BY sort_order, psi.chapter_code_snapshot`, [ projectId, standardVersionId ]);
    const params = [ projectId, standardVersionId ];
    const predicates = [ 'psi.project_id = $1', 'si.standard_version_id = $2' ];
    if (chapterCode) {
      params.push(chapterCode);
      predicates.push(`psi.chapter_code_snapshot = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      predicates.push(`(
        psi.standard_number_snapshot ILIKE $${params.length}
        OR psi.item_code_snapshot ILIKE $${params.length}
        OR COALESCE(psi.title_snapshot, '') ILIKE $${params.length}
        OR psi.content_snapshot ILIKE $${params.length}
        OR COALESCE(psi.explanation_snapshot, '') ILIKE $${params.length}
        OR psi.heading_path_snapshot::text ILIKE $${params.length}
      )`);
    }
    if ([ 'satisfied', 'partially_satisfied', 'not_satisfied', 'unassessed' ].includes(status)) {
      params.push(status);
      predicates.push(`COALESCE(psa.status, 'unassessed') = $${params.length}`);
    }
    const where = predicates.join(' AND ');
    const chapterResult = await this.pool.query(`
      SELECT psi.chapter_code_snapshot AS code,
             COALESCE(sc.name, psi.chapter_code_snapshot) AS name,
             COALESCE(sc.sort_order, 0) AS sort_order,
             count(*)::integer AS item_count
      FROM project_standard_items psi
      JOIN standard_items si ON si.id = psi.standard_item_id
      LEFT JOIN standard_chapters sc ON sc.id = si.chapter_id
      LEFT JOIN project_standard_answers psa ON psa.project_id = psi.project_id
        AND psa.standard_item_id = psi.standard_item_id AND psa.cloud_center_id IS NULL
      WHERE ${where}
      GROUP BY psi.chapter_code_snapshot, sc.name, sc.sort_order
      ORDER BY COALESCE(sc.sort_order, 0), psi.chapter_code_snapshot`, params);
    const filteredChapters = chapterResult.rows;
    const totalItems = filteredChapters.reduce((sum, chapter) => sum + chapter.item_count, 0);
    const pageSizeValue = [ '1', '2', '5', '10', '20', 'all' ].includes(String(chapterPageSize)) ? String(chapterPageSize) : '1';
    const normalizedPageSize = pageSizeValue === 'all' ? Math.max(1, filteredChapters.length) : Number(pageSizeValue);
    const pageCount = Math.max(1, Math.ceil(filteredChapters.length / normalizedPageSize));
    const currentPage = Math.min(Math.max(1, Number(chapterPage) || 1), pageCount);
    const chapterOffset = (currentPage - 1) * normalizedPageSize;
    const chapters = filteredChapters.slice(chapterOffset, chapterOffset + normalizedPageSize);
    const chapterCodes = chapters.map(chapter => chapter.code);
    let items = { rows: [] };
    if (chapterCodes.length) {
      const dataParams = [ ...params, chapterCodes ];
      items = await this.pool.query(`
      SELECT psi.standard_item_id, psi.standard_number_snapshot, psi.item_code_snapshot,
             psi.content_snapshot,
             psi.explanation_snapshot, psi.chapter_code_snapshot, psi.heading_path_snapshot,
             psi.title_snapshot AS title, COALESCE(sc.name, psi.chapter_code_snapshot) AS chapter_name,
             COALESCE(psa.is_key, false) AS is_key,
             COALESCE(psa.clause_assignment, '') AS clause_assignment,
             COALESCE(psa.assignment_details, '[]'::jsonb) AS assignment_details,
             COALESCE(psa.compliance_description, '') AS compliance_description,
             COALESCE(psa.expected_evidence, '') AS expected_evidence,
             COALESCE(psa.pending_evidence, '') AS pending_evidence,
             COALESCE(psa.responsible_text, '') AS responsible_text,
             COALESCE(psa.applicability, 'unspecified') AS applicability,
             COALESCE(psa.status, 'unassessed') AS answer_status,
             COALESCE(psa.actual_evidence, '') AS actual_evidence,
             COALESCE(psa.answer_notes, '') AS answer_notes
      FROM project_standard_items psi
      JOIN standard_items si ON si.id = psi.standard_item_id
      LEFT JOIN standard_chapters sc ON sc.id = si.chapter_id
      LEFT JOIN project_standard_answers psa ON psa.project_id = psi.project_id
        AND psa.standard_item_id = psi.standard_item_id AND psa.cloud_center_id IS NULL
      WHERE ${where} AND psi.chapter_code_snapshot = ANY($${dataParams.length}::text[])
      ORDER BY COALESCE(sc.sort_order, 0), psi.chapter_code_snapshot, ${orderBy} ${direction}, psi.standard_number_snapshot ASC`, dataParams);
    }
    return {
      project: versionResult.rows[0],
      chapters,
      chapterOptions: chapterOptionsResult.rows,
      items: items.rows,
      pagination: {
        page: currentPage,
        pageSize: pageSizeValue,
        pageCount,
        firstChapter: filteredChapters.length ? chapterOffset + 1 : 0,
        lastChapter: Math.min(chapterOffset + normalizedPageSize, filteredChapters.length),
        totalChapters: filteredChapters.length,
        totalItems,
      },
      filters: { search, chapterCode, status, sortBy: validSorts[sortBy] ? sortBy : 'standardNumber', sortDirection: direction.toLowerCase() },
    };
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
          (project_id, standard_item_id, standard_number_snapshot, item_code_snapshot, title_snapshot,
           explanation_snapshot, content_snapshot, chapter_code_snapshot, heading_path_snapshot, snapshotted_at)
        SELECT $1, si.id, si.standard_number, si.item_code, si.title,
               COALESCE(si.explanation, parent.explanation), si.content, sc.code, si.heading_path, now()
        FROM standard_items si
        JOIN standard_chapters sc ON sc.id = si.chapter_id
        LEFT JOIN standard_items parent ON parent.standard_version_id = si.standard_version_id
          AND parent.item_code = regexp_replace(si.item_code, $3, $4)
        WHERE si.standard_version_id = $2
        ON CONFLICT DO NOTHING`, [ projectId, standardVersionId, '\\s+[a-z]\\s*[)）)_]\\s*$', '' ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async syncProjectStandardVersion({ projectId, standardVersionId, actorId }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const baseline = await client.query(`
        SELECT psv.project_id, psv.standard_version_id, s.code AS standard_code,
               s.name AS standard_name, sv.version
        FROM project_standard_versions psv
        JOIN standard_versions sv ON sv.id = psv.standard_version_id
        JOIN standards s ON s.id = sv.standard_id
        WHERE psv.project_id = $1 AND psv.standard_version_id = $2
        FOR UPDATE OF psv, sv`, [ projectId, standardVersionId ]);
      if (!baseline.rowCount) {
        const error = new Error('该规范版次不在当前项目中');
        error.code = 'PROJECT_STANDARD_VERSION_NOT_FOUND';
        throw error;
      }

      const counts = await client.query(`
        SELECT count(si.id)::integer AS total_count,
               count(*) FILTER (WHERE psi.standard_item_id IS NULL)::integer AS added_count,
               count(*) FILTER (WHERE psi.standard_item_id IS NOT NULL AND (
                 psi.standard_number_snapshot IS DISTINCT FROM si.standard_number
                 OR psi.item_code_snapshot IS DISTINCT FROM si.item_code
                 OR psi.title_snapshot IS DISTINCT FROM si.title
                 OR psi.explanation_snapshot IS DISTINCT FROM COALESCE(si.explanation, parent.explanation)
                 OR psi.content_snapshot IS DISTINCT FROM si.content
                 OR psi.chapter_code_snapshot IS DISTINCT FROM sc.code
                 OR psi.heading_path_snapshot IS DISTINCT FROM si.heading_path
               ))::integer AS updated_count
        FROM standard_items si
        JOIN standard_chapters sc ON sc.id = si.chapter_id
        LEFT JOIN standard_items parent ON parent.standard_version_id = si.standard_version_id
          AND parent.item_code = regexp_replace(si.item_code, $3, $4)
        LEFT JOIN project_standard_items psi
          ON psi.project_id = $1 AND psi.standard_item_id = si.id
        WHERE si.standard_version_id = $2`, [ projectId, standardVersionId, '\\s+[a-z]\\s*[)）)_]\\s*$', '' ]);
      const summary = counts.rows[0];
      await client.query(`
        INSERT INTO project_standard_items
          (project_id, standard_item_id, standard_number_snapshot, item_code_snapshot, title_snapshot,
           explanation_snapshot, content_snapshot, chapter_code_snapshot, heading_path_snapshot, snapshotted_at)
        SELECT $1, si.id, si.standard_number, si.item_code, si.title,
               COALESCE(si.explanation, parent.explanation), si.content,
               sc.code, si.heading_path, now()
        FROM standard_items si
        JOIN standard_chapters sc ON sc.id = si.chapter_id
        LEFT JOIN standard_items parent ON parent.standard_version_id = si.standard_version_id
          AND parent.item_code = regexp_replace(si.item_code, $3, $4)
        WHERE si.standard_version_id = $2
        ON CONFLICT (project_id, standard_item_id) DO UPDATE SET
          standard_number_snapshot = EXCLUDED.standard_number_snapshot,
          item_code_snapshot = EXCLUDED.item_code_snapshot,
          title_snapshot = EXCLUDED.title_snapshot,
          explanation_snapshot = EXCLUDED.explanation_snapshot,
          content_snapshot = EXCLUDED.content_snapshot,
          chapter_code_snapshot = EXCLUDED.chapter_code_snapshot,
          heading_path_snapshot = EXCLUDED.heading_path_snapshot,
          snapshotted_at = now()
        WHERE project_standard_items.standard_number_snapshot IS DISTINCT FROM EXCLUDED.standard_number_snapshot
          OR project_standard_items.item_code_snapshot IS DISTINCT FROM EXCLUDED.item_code_snapshot
          OR project_standard_items.title_snapshot IS DISTINCT FROM EXCLUDED.title_snapshot
          OR project_standard_items.explanation_snapshot IS DISTINCT FROM EXCLUDED.explanation_snapshot
          OR project_standard_items.content_snapshot IS DISTINCT FROM EXCLUDED.content_snapshot
          OR project_standard_items.chapter_code_snapshot IS DISTINCT FROM EXCLUDED.chapter_code_snapshot
          OR project_standard_items.heading_path_snapshot IS DISTINCT FROM EXCLUDED.heading_path_snapshot`, [ projectId, standardVersionId, '\\s+[a-z]\\s*[)）)_]\\s*$', '' ]);
      await client.query(`
        UPDATE project_standard_versions SET snapshot_at = now()
        WHERE project_id = $1 AND standard_version_id = $2`, [ projectId, standardVersionId ]);
      const result = {
        totalCount: Number(summary.total_count || 0),
        addedCount: Number(summary.added_count || 0),
        updatedCount: Number(summary.updated_count || 0),
        unchangedCount: Number(summary.total_count || 0) - Number(summary.added_count || 0) - Number(summary.updated_count || 0),
      };
      await client.query(`
        INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'sync_project_standard_snapshot', 'project_standard_version', $2, $3::jsonb)`, [
        actorId || null,
        standardVersionId,
        JSON.stringify({ projectId, ...baseline.rows[0], ...result }),
      ]);
      await client.query('COMMIT');
      return result;
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

  async listAnswerTemplateRows(projectId) {
    const result = await this.pool.query(`
      SELECT psi.standard_number_snapshot, psi.item_code_snapshot,
             COALESCE(psa.is_key, false) AS is_key,
             COALESCE(psa.clause_assignment, '') AS clause_assignment,
             COALESCE(psa.assignment_details, '[]'::jsonb) AS assignment_details,
             COALESCE(psa.compliance_description, '') AS compliance_description,
             COALESCE(psa.actual_evidence, '') AS actual_evidence,
             COALESCE(psa.applicability, 'unspecified') AS applicability,
             COALESCE(psa.status, 'unassessed') AS answer_status,
             COALESCE(psa.answer_notes, '') AS answer_notes
      FROM project_standard_items psi
      LEFT JOIN project_standard_answers psa
        ON psa.project_id = psi.project_id
       AND psa.standard_item_id = psi.standard_item_id
       AND psa.cloud_center_id IS NULL
      WHERE psi.project_id = $1
      ORDER BY psi.chapter_code_snapshot, psi.standard_number_snapshot`,
    [ projectId ]);
    return result.rows;
  }

  async getProjectStandardItemContext(projectId, standardItemId) {
    const result = await this.pool.query(`
      SELECT standard_item_id, item_code_snapshot, explanation_snapshot, content_snapshot
      FROM project_standard_items
      WHERE project_id = $1 AND standard_item_id = $2`, [ projectId, standardItemId ]);
    return result.rows[0] || null;
  }

  async saveAnswer({ projectId, standardItemId, isKey, clauseAssignment, assignmentDetails, complianceDescription, expectedEvidence, applicability, status, actualEvidence, answerNotes, ownerUserId }) {
    const result = await this.pool.query(`
      INSERT INTO project_standard_answers
        (project_id, standard_item_id, is_key, clause_assignment, assignment_details,
         compliance_description, expected_evidence, applicability, status, actual_evidence,
         answer_notes, owner_user_id, updated_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, now())
      ON CONFLICT (project_id, standard_item_id) WHERE cloud_center_id IS NULL DO UPDATE SET
        is_key = EXCLUDED.is_key,
        clause_assignment = EXCLUDED.clause_assignment,
        assignment_details = EXCLUDED.assignment_details,
        compliance_description = EXCLUDED.compliance_description,
        expected_evidence = EXCLUDED.expected_evidence,
        applicability = EXCLUDED.applicability,
        status = EXCLUDED.status, actual_evidence = EXCLUDED.actual_evidence,
        answer_notes = EXCLUDED.answer_notes, owner_user_id = EXCLUDED.owner_user_id,
        updated_at = now()
      RETURNING *`, [
      projectId, standardItemId, isKey === true,
      clauseAssignment || null, JSON.stringify(assignmentDetails || []),
      complianceDescription || null, expectedEvidence || null,
      applicability, status, actualEvidence || null,
      answerNotes || null, ownerUserId || null,
    ]);
    return result.rows[0];
  }
}

module.exports = ProjectRepository;
