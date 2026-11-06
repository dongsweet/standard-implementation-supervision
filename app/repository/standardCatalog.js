'use strict';

class StandardCatalogRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listCatalog({ search = '', standardType = '', page = 1, pageSize = 20 } = {}) {
    const conditions = [];
    const values = [];
    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(
        s.code ILIKE $${values.length}
        OR s.name ILIKE $${values.length}
        OR COALESCE(s.issuing_organization, '') ILIKE $${values.length}
      )`);
    }
    if (standardType) {
      values.push(standardType);
      conditions.push(`s.standard_type = $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countSql = `
      SELECT count(*)::integer AS total
      FROM standards s
      JOIN standard_versions sv ON sv.standard_id = s.id
      ${where}`;
    const countResult = values.length ? await this.pool.query(countSql, values) : await this.pool.query(countSql);
    const total = countResult.rows[0].total;
    const offset = (page - 1) * pageSize;
    const listValues = [ ...values, pageSize, offset ];
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;
    const result = await this.pool.query(`
      SELECT s.id AS standard_id, s.code, s.name, s.description,
             s.standard_type, s.issuing_organization,
             sv.id AS version_id, sv.version, sv.status,
             sv.published_at, sv.created_at,
             (SELECT count(*)::integer FROM standard_chapters sc WHERE sc.standard_version_id = sv.id) AS chapter_count,
             (SELECT count(*)::integer FROM standard_items si WHERE si.standard_version_id = sv.id) AS item_count
      FROM standards s
      JOIN standard_versions sv ON sv.standard_id = s.id
      ${where}
      ORDER BY s.code, sv.created_at DESC
      LIMIT $${limitParameter} OFFSET $${offsetParameter}`, listValues);
    const options = await this.pool.query(`
      SELECT id, code, name
      FROM standards
      ORDER BY code, name`);
    return {
      rows: result.rows,
      standardOptions: options.rows,
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async createStandard({ code, name, description, standardType, issuingOrganization, version }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const standard = await client.query(`
        INSERT INTO standards (code, name, description, standard_type, issuing_organization)
        VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [ code, name, description || null, standardType, issuingOrganization || null ]);
      const standardVersion = await client.query(`
        INSERT INTO standard_versions (standard_id, version, status)
        VALUES ($1, $2, 'draft') RETURNING *`, [ standard.rows[0].id, version ]);
      await client.query('COMMIT');
      return { ...standard.rows[0], initialVersion: standardVersion.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createVersion({ standardId, version }) {
    const result = await this.pool.query(`
      INSERT INTO standard_versions (standard_id, version, status)
      VALUES ($1, $2, 'draft') RETURNING *`, [ standardId, version ]);
    return result.rows[0];
  }

  async getVersionDetail(versionId) {
    const versionResult = await this.pool.query(`
      SELECT sv.*, s.code AS standard_code, s.name AS standard_name, s.description AS standard_description,
             s.standard_type, s.issuing_organization
      FROM standard_versions sv JOIN standards s ON s.id = sv.standard_id
      WHERE sv.id = $1`, [ versionId ]);
    if (!versionResult.rowCount) return null;
    const chapters = await this.pool.query(`
      SELECT sc.id, sc.code, sc.name, sc.sort_order,
             count(si.id)::integer AS item_count,
             COALESCE(json_agg(json_build_object(
               'id', si.id, 'itemCode', si.item_code, 'title', si.title,
               'content', si.content, 'level', si.level, 'isKey', si.is_key,
               'metadata', si.metadata,
               'providers', COALESCE((SELECT json_agg(spa.provider_name ORDER BY spa.provider_name) FROM standard_provider_assignments spa WHERE spa.standard_item_id = si.id), '[]'::json),
               'requirements', COALESCE((SELECT json_agg(json_build_object('requirement', sir.unified_requirement, 'evidence', sir.implementation_evidence) ORDER BY sir.sort_order, sir.id) FROM standard_item_requirements sir WHERE sir.standard_item_id = si.id), '[]'::json)
             ) ORDER BY si.item_code) FILTER (WHERE si.id IS NOT NULL), '[]'::json) AS items
      FROM standard_chapters sc
      LEFT JOIN standard_items si ON si.chapter_id = sc.id
      WHERE sc.standard_version_id = $1
      GROUP BY sc.id
      ORDER BY sc.sort_order, sc.code`, [ versionId ]);
    return { version: versionResult.rows[0], chapters: chapters.rows };
  }

  async createChapter({ versionId, code, name, sortOrder }) {
    const result = await this.pool.query(`
      INSERT INTO standard_chapters (standard_version_id, code, name, sort_order)
      VALUES ($1, $2, $3, $4) RETURNING *`, [ versionId, code, name, sortOrder || 0 ]);
    return result.rows[0];
  }

  async findChapter(chapterId) {
    const result = await this.pool.query(`
      SELECT sc.*, sv.standard_id, sv.version, s.code AS standard_code
      FROM standard_chapters sc
      JOIN standard_versions sv ON sv.id = sc.standard_version_id
      JOIN standards s ON s.id = sv.standard_id
      WHERE sc.id = $1`, [ chapterId ]);
    return result.rows[0] || null;
  }

  async createItem({ versionId, chapterId, itemCode, title, content, level, isKey, metadata, providerNames = [], unifiedRequirement, implementationEvidence }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
      INSERT INTO standard_items
        (standard_version_id, chapter_id, item_code, title, content, level, is_key, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      RETURNING *`, [ versionId, chapterId, itemCode, title || null, content, level || null, isKey === true, JSON.stringify(metadata || {}) ]);
      const itemId = result.rows[0].id;
      for (const provider of providerNames) {
        await client.query('INSERT INTO standard_provider_assignments (standard_item_id, provider_name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ itemId, provider ]);
      }
      if (unifiedRequirement) {
        await client.query(`INSERT INTO standard_item_requirements (standard_item_id, unified_requirement, implementation_evidence) VALUES ($1, $2, $3)`, [ itemId, unifiedRequirement, implementationEvidence || null ]);
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

  async upsertItems({ versionId, chapterId, rows }) {
    const client = await this.pool.connect();
    let count = 0;
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        await client.query(`
          INSERT INTO standard_items
            (standard_version_id, chapter_id, item_code, title, content, level, is_key, metadata)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
          ON CONFLICT (standard_version_id, item_code) DO UPDATE SET
            chapter_id = EXCLUDED.chapter_id, title = EXCLUDED.title, content = EXCLUDED.content,
            level = EXCLUDED.level, is_key = EXCLUDED.is_key, metadata = EXCLUDED.metadata`,
        [ versionId, chapterId, row.itemCode, row.title || null, row.content, row.level || null, row.isKey === true, JSON.stringify(row.metadata || {}) ]);
        const itemResult = await client.query('SELECT id FROM standard_items WHERE standard_version_id = $1 AND item_code = $2', [ versionId, row.itemCode ]);
        const itemId = itemResult.rows[0].id;
        for (const provider of row.providerNames || []) {
          await client.query('INSERT INTO standard_provider_assignments (standard_item_id, provider_name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ itemId, provider ]);
        }
        if (row.unifiedRequirement) {
          await client.query('DELETE FROM standard_item_requirements WHERE standard_item_id = $1', [ itemId ]);
          await client.query('INSERT INTO standard_item_requirements (standard_item_id, unified_requirement, implementation_evidence) VALUES ($1, $2, $3)', [ itemId, row.unifiedRequirement, row.implementationEvidence || null ]);
        }
        count += 1;
      }
      await client.query('COMMIT');
      return count;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async publishVersion(versionId) {
    const result = await this.pool.query(`
      UPDATE standard_versions SET status = 'published', published_at = COALESCE(published_at, now())
      WHERE id = $1 RETURNING *`, [ versionId ]);
    return result.rows[0] || null;
  }
}

module.exports = StandardCatalogRepository;
