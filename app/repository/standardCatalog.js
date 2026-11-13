'use strict';

const { chapterStandardNumber, itemStandardNumber, recalculateStandardNumbers, topLevelChapterCode } = require('../lib/standardNumber');

function normalizeCode(value) {
  return String(value || '').normalize('NFKC').toUpperCase();
}

function normalizeChapters(chapters) {
  const grouped = new Map();
  for (const chapter of chapters || []) {
    const rootCode = topLevelChapterCode(chapter.code);
    let target = grouped.get(normalizeCode(rootCode));
    if (!target) {
      target = {
        code: rootCode,
        name: String(chapter.code) === String(rootCode) ? chapter.name : `第${rootCode}章`,
        sortOrder: chapter.sortOrder || 0,
        items: [],
      };
      grouped.set(normalizeCode(rootCode), target);
    }
    target.sortOrder = Math.min(target.sortOrder, chapter.sortOrder || 0);
    if (String(chapter.code) === String(rootCode)) target.name = chapter.name;
    for (const item of chapter.items || []) {
      const headingPath = [ ...(item.headingPath || []) ];
      if (String(chapter.code || '') !== String(rootCode)) {
        headingPath.unshift({
          level: String(chapter.code).split('.').length,
          number: chapter.code,
          title: chapter.name,
        });
      }
      target.items.push({ ...item, headingPath });
    }
  }
  return Array.from(grouped.values()).sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code));
}

async function insertMany(client, table, columns, rows, options = {}) {
  const output = [];
  const batchSize = options.batchSize || 300;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const placeholders = batch.map((row, rowIndex) => '(' + row.map((value, columnIndex) => '$' + (rowIndex * columns.length + columnIndex + 1)).join(', ') + ')').join(', ');
    const sql = 'INSERT INTO ' + table + ' (' + columns.join(', ') + ') VALUES ' + placeholders
      + (options.onConflict ? ' ' + options.onConflict : '')
      + (options.returning ? ' RETURNING ' + options.returning : '');
    const result = await client.query(sql, batch.flat());
    output.push(...(result.rows || []));
  }
  return output;
}

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
             sv.id AS version_id, sv.version,
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
        INSERT INTO standard_versions (standard_id, version)
        VALUES ($1, $2) RETURNING *`, [ standard.rows[0].id, version ]);
      await client.query('COMMIT');
      return { ...standard.rows[0], initialVersion: standardVersion.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async importStandard({ code, name, description, standardType, issuingOrganization, version, chapters }) {
    chapters = normalizeChapters(chapters);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const standardResult = await client.query(
        'INSERT INTO standards (code, name, description, standard_type, issuing_organization) VALUES ($1, $2, $3, $4, $5) RETURNING id, code, name',
        [ code, name, description || null, standardType, issuingOrganization || null ]
      );
      const standard = standardResult.rows[0];
      const versionResult = await client.query(
        'INSERT INTO standard_versions (standard_id, version) VALUES ($1, $2) RETURNING id, version',
        [ standard.id, version ]
      );
      const standardVersion = versionResult.rows[0];
      const chapterIds = new Map();
      for (const chapter of chapters) {
        const result = await client.query(
          'INSERT INTO standard_chapters (standard_version_id, code, name, sort_order, standard_number) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [ standardVersion.id, chapter.code, chapter.name, chapter.sortOrder, chapterStandardNumber(standard.code, version, chapter.code) ]
        );
        chapterIds.set(chapter.code, result.rows[0].id);
      }

      const items = chapters.flatMap(chapter => chapter.items.map((item, index) => ({
        ...item, chapterId: chapterIds.get(chapter.code),
        importOrder: index + 1,
        standardNumber: itemStandardNumber(standard.code, version, chapter.code, index + 1),
      })));
      await insertMany(client, 'standard_items',
        [ 'standard_version_id', 'chapter_id', 'item_code', 'title', 'content', 'heading_path', 'import_order', 'standard_number' ],
        items.map(item => [
          standardVersion.id, item.chapterId, item.itemCode, item.title || null, item.content,
          JSON.stringify(item.headingPath || []), item.importOrder, item.standardNumber,
        ]),
        { returning: 'id, item_code' });
      await recalculateStandardNumbers(client, standardVersion.id);
      await client.query('COMMIT');
      return {
        standardId: standard.id,
        versionId: standardVersion.id,
        standardCode: standard.code,
        standardName: standard.name,
        version: standardVersion.version,
        chapterCount: chapters.length,
        itemCount: items.length,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async importVersionContent({ versionId, chapters }) {
    chapters = normalizeChapters(chapters);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const version = await client.query('SELECT id FROM standard_versions WHERE id = $1 FOR UPDATE', [ versionId ]);
      if (!version.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const standard = await client.query(`
        SELECT s.code, sv.version
        FROM standard_versions sv JOIN standards s ON s.id = sv.standard_id
        WHERE sv.id = $1`, [ versionId ]);
      const standardCode = standard.rows[0].code;
      const versionLabel = standard.rows[0].version;

      const existingChapters = await client.query(
        'SELECT id, code FROM standard_chapters WHERE standard_version_id = $1',
        [ versionId ]
      );
      const chapterByExactCode = new Map(existingChapters.rows.map(chapter => [ chapter.code, chapter ]));
      const chapterByNormalizedCode = new Map(existingChapters.rows.map(chapter => [ normalizeCode(chapter.code), chapter ]));
      const chapterRows = chapters.map(chapter => {
        const existing = chapterByExactCode.get(chapter.code) || chapterByNormalizedCode.get(normalizeCode(chapter.code));
        const code = existing ? existing.code : chapter.code;
        return [ versionId, code, chapter.name, chapter.sortOrder, chapterStandardNumber(standardCode, versionLabel, code) ];
      });
      const savedChapters = await insertMany(client, 'standard_chapters',
        [ 'standard_version_id', 'code', 'name', 'sort_order', 'standard_number' ], chapterRows, {
          onConflict: 'ON CONFLICT (standard_version_id, code) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, standard_number = EXCLUDED.standard_number',
          returning: 'id, code',
        });
      const chapterIds = new Map(savedChapters.map(chapter => [ normalizeCode(chapter.code), chapter.id ]));

      const existingItems = await client.query(
        'SELECT id, item_code, import_order FROM standard_items WHERE standard_version_id = $1',
        [ versionId ]
      );
      const itemByExactCode = new Map(existingItems.rows.map(item => [ item.item_code, item ]));
      const itemByNormalizedCode = new Map(existingItems.rows.map(item => [ normalizeCode(item.item_code), item ]));
      const items = chapters.flatMap(chapter => chapter.items.map((item, index) => {
        const existing = itemByExactCode.get(item.itemCode) || itemByNormalizedCode.get(normalizeCode(item.itemCode));
        const code = existing ? existing.item_code : item.itemCode;
        const importOrder = index + 1;
        return {
          ...item,
          chapterId: chapterIds.get(normalizeCode(chapter.code)),
          databaseItemCode: code,
          importOrder,
          standardNumber: `TEMP-${versionId}-${code}`,
        };
      }));
      await insertMany(client, 'standard_items',
        [ 'standard_version_id', 'chapter_id', 'item_code', 'title', 'content', 'heading_path', 'import_order', 'standard_number' ],
        items.map(item => [
          versionId, item.chapterId, item.databaseItemCode, item.title || null, item.content,
          JSON.stringify(item.headingPath || []), item.importOrder, item.standardNumber,
        ]),
        {
          onConflict: `ON CONFLICT (standard_version_id, item_code) DO UPDATE SET
            chapter_id = EXCLUDED.chapter_id, title = EXCLUDED.title, content = EXCLUDED.content,
            heading_path = EXCLUDED.heading_path,
            import_order = EXCLUDED.import_order, standard_number = EXCLUDED.standard_number`,
          returning: 'id, item_code',
        });
      await recalculateStandardNumbers(client, versionId);
      await client.query('COMMIT');
      return { chapterCount: chapters.length, itemCount: items.length };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createVersion({ standardId, version }) {
    const result = await this.pool.query(`
      INSERT INTO standard_versions (standard_id, version)
      VALUES ($1, $2) RETURNING *`, [ standardId, version ]);
    return result.rows[0];
  }

  async updateStandard({ standardId, versionId, code, name, description, standardType, issuingOrganization, version }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const standard = await client.query(`
        UPDATE standards
        SET code = $2, name = $3, description = $4,
            standard_type = $5, issuing_organization = $6
        WHERE id = $1
        RETURNING id, code, name, description, standard_type, issuing_organization`,
      [ standardId, code, name, description, standardType, issuingOrganization ]);
      const standardVersion = await client.query(`
        UPDATE standard_versions
        SET version = $3
        WHERE id = $1 AND standard_id = $2
        RETURNING id, standard_id, version`, [ versionId, standardId, version ]);
      if (!standard.rowCount || !standardVersion.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      await recalculateStandardNumbers(client, versionId);
      await client.query('COMMIT');
      return { ...standard.rows[0], version: standardVersion.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getVersionDetail(versionId) {
    const versionResult = await this.pool.query(`
      SELECT sv.id, sv.standard_id, sv.version, s.code AS standard_code, s.name AS standard_name, s.description AS standard_description,
             s.standard_type, s.issuing_organization
      FROM standard_versions sv JOIN standards s ON s.id = sv.standard_id
      WHERE sv.id = $1`, [ versionId ]);
    if (!versionResult.rowCount) return null;
    const chapters = await this.pool.query(`
      SELECT sc.id, sc.code, sc.name, sc.sort_order, sc.standard_number,
             count(si.id)::integer AS item_count,
             COALESCE(json_agg(json_build_object(
               'id', si.id, 'standardNumber', si.standard_number,
             'itemCode', si.item_code, 'title', si.title, 'content', si.content, 'headingPath', si.heading_path,
               'sourcePageFrom', si.source_page_from, 'sourcePageTo', si.source_page_to
             ) ORDER BY si.import_order, si.item_code) FILTER (WHERE si.id IS NOT NULL), '[]'::json) AS items
      FROM standard_chapters sc
      LEFT JOIN standard_items si ON si.chapter_id = sc.id
      WHERE sc.standard_version_id = $1
      GROUP BY sc.id
      ORDER BY sc.sort_order, sc.code`, [ versionId ]);
    return { version: versionResult.rows[0], chapters: chapters.rows };
  }

  async clearVersionContent({ versionId, actorId }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const version = await client.query(`
        SELECT sv.id, sv.version, s.code AS standard_code, s.name AS standard_name
        FROM standard_versions sv JOIN standards s ON s.id = sv.standard_id
        WHERE sv.id = $1 FOR UPDATE`, [ versionId ]);
      if (!version.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }

      const references = await client.query(`
        SELECT
          (SELECT count(*)::integer FROM project_standard_items psi JOIN standard_items si ON si.id = psi.standard_item_id WHERE si.standard_version_id = $1) AS project_items,
          (SELECT count(*)::integer FROM project_standard_answers psa JOIN standard_items si ON si.id = psa.standard_item_id WHERE si.standard_version_id = $1) AS project_answers,
          (SELECT count(*)::integer FROM supervision_definition_standard_items dsi JOIN standard_items si ON si.id = dsi.standard_item_id WHERE si.standard_version_id = $1) AS supervision_definitions,
          (SELECT count(*)::integer FROM supervision_item_results sir JOIN standard_items si ON si.id = sir.standard_item_id WHERE si.standard_version_id = $1) AS supervision_results,
          (SELECT count(*)::integer FROM chapter_responsibilities cr JOIN standard_chapters sc ON sc.id = cr.chapter_id WHERE sc.standard_version_id = $1) AS chapter_responsibilities`, [ versionId ]);
      const blocked = Object.entries(references.rows[0]).filter(([, count ]) => Number(count) > 0);
      if (blocked.length) {
        const error = new Error('当前规范版本已被项目或监督记录引用，不能清空内容；请先解除相关引用');
        error.code = 'STANDARD_CONTENT_REFERENCED';
        error.references = Object.fromEntries(blocked);
        throw error;
      }

      const deleted = await client.query(`
        DELETE FROM standard_chapters
        WHERE standard_version_id = $1
        RETURNING id`, [ versionId ]);
      await client.query(`
        INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'clear_standard_version_content', 'standard_version', $2, $3)`, [
        actorId || null,
        versionId,
        JSON.stringify({ standardCode: version.rows[0].standard_code, chapterCount: deleted.rowCount }),
      ]);
      await client.query('COMMIT');
      return { chapterCount: deleted.rowCount, standardCode: version.rows[0].standard_code, version: version.rows[0].version };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createChapter({ versionId, code, name, sortOrder }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const standard = await client.query(`
        SELECT s.code, sv.version
        FROM standard_versions sv JOIN standards s ON s.id = sv.standard_id
        WHERE sv.id = $1 FOR UPDATE`, [ versionId ]);
      if (!standard.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const result = await client.query(`
        INSERT INTO standard_chapters (standard_version_id, code, name, sort_order, standard_number)
        VALUES ($1, $2, $3, $4, $5) RETURNING *`, [
        versionId, code, name, sortOrder || 0,
        chapterStandardNumber(standard.rows[0].code, standard.rows[0].version, code),
      ]);
      await recalculateStandardNumbers(client, versionId);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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

  async createItem({ versionId, chapterId, itemCode, title, content }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const chapter = await client.query(`
        SELECT sc.code, s.code AS standard_code, sv.version,
               COALESCE(MAX(si.import_order), 0)::integer + 1 AS import_order
        FROM standard_chapters sc
        JOIN standard_versions sv ON sv.id = sc.standard_version_id
        JOIN standards s ON s.id = sv.standard_id
        LEFT JOIN standard_items si ON si.chapter_id = sc.id
        WHERE sc.id = $1 AND sc.standard_version_id = $2
        GROUP BY sc.id, sc.code, s.code, sv.version`, [ chapterId, versionId ]);
      if (!chapter.rowCount) {
        const error = new Error('章节不存在');
        error.code = 'MISSING_CHAPTER';
        throw error;
      }
      const result = await client.query(`
      INSERT INTO standard_items
        (standard_version_id, chapter_id, item_code, title, content, heading_path, import_order, standard_number)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`, [
        versionId, chapterId, itemCode, title || null, content, '[]',
        chapter.rows[0].import_order,
        `TEMP-${versionId}-${itemCode}`,
      ]);
      await recalculateStandardNumbers(client, versionId);
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
      const chapter = await client.query(`
        SELECT sc.code, s.code AS standard_code, sv.version
        FROM standard_chapters sc
        JOIN standard_versions sv ON sv.id = sc.standard_version_id
        JOIN standards s ON s.id = sv.standard_id
        WHERE sc.id = $1 AND sc.standard_version_id = $2`, [ chapterId, versionId ]);
      if (!chapter.rowCount) {
        const error = new Error('章节不存在');
        error.code = 'MISSING_CHAPTER';
        throw error;
      }
      for (const [ index, row ] of rows.entries()) {
        await client.query(`
          INSERT INTO standard_items
            (standard_version_id, chapter_id, item_code, title, content, heading_path, import_order, standard_number)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (standard_version_id, item_code) DO UPDATE SET
            chapter_id = EXCLUDED.chapter_id, title = EXCLUDED.title, content = EXCLUDED.content,
            heading_path = EXCLUDED.heading_path,
            import_order = EXCLUDED.import_order, standard_number = EXCLUDED.standard_number`,
        [ versionId, chapterId, row.itemCode, row.title || null, row.content,
          JSON.stringify(row.headingPath || []), index + 1, `TEMP-${versionId}-${row.itemCode}` ]);
        count += 1;
      }
      await recalculateStandardNumbers(client, versionId);
      await client.query('COMMIT');
      return count;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

}

module.exports = StandardCatalogRepository;
