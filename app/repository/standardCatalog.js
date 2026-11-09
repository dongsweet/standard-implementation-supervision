'use strict';

function normalizeCode(value) {
  return String(value || '').normalize('NFKC').toUpperCase();
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
          'INSERT INTO standard_chapters (standard_version_id, code, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
          [ standardVersion.id, chapter.code, chapter.name, chapter.sortOrder ]
        );
        chapterIds.set(chapter.code, result.rows[0].id);
      }

      const items = chapters.flatMap(chapter => chapter.items.map(item => ({
        ...item, chapterId: chapterIds.get(chapter.code),
      })));
      await insertMany(client, 'standard_items',
        [ 'standard_version_id', 'chapter_id', 'item_code', 'title', 'content' ],
        items.map(item => [
          standardVersion.id, item.chapterId, item.itemCode, item.title || null, item.content,
        ]),
        { returning: 'id, item_code' });
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const version = await client.query('SELECT id FROM standard_versions WHERE id = $1 FOR UPDATE', [ versionId ]);
      if (!version.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }

      const existingChapters = await client.query(
        'SELECT id, code FROM standard_chapters WHERE standard_version_id = $1',
        [ versionId ]
      );
      const chapterByExactCode = new Map(existingChapters.rows.map(chapter => [ chapter.code, chapter ]));
      const chapterByNormalizedCode = new Map(existingChapters.rows.map(chapter => [ normalizeCode(chapter.code), chapter ]));
      const chapterRows = chapters.map(chapter => {
        const existing = chapterByExactCode.get(chapter.code) || chapterByNormalizedCode.get(normalizeCode(chapter.code));
        return [ versionId, existing ? existing.code : chapter.code, chapter.name, chapter.sortOrder ];
      });
      const savedChapters = await insertMany(client, 'standard_chapters',
        [ 'standard_version_id', 'code', 'name', 'sort_order' ], chapterRows, {
          onConflict: 'ON CONFLICT (standard_version_id, code) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order',
          returning: 'id, code',
        });
      const chapterIds = new Map(savedChapters.map(chapter => [ normalizeCode(chapter.code), chapter.id ]));

      const existingItems = await client.query(
        'SELECT id, item_code FROM standard_items WHERE standard_version_id = $1',
        [ versionId ]
      );
      const itemByExactCode = new Map(existingItems.rows.map(item => [ item.item_code, item ]));
      const itemByNormalizedCode = new Map(existingItems.rows.map(item => [ normalizeCode(item.item_code), item ]));
      const items = chapters.flatMap(chapter => chapter.items.map(item => {
        const existing = itemByExactCode.get(item.itemCode) || itemByNormalizedCode.get(normalizeCode(item.itemCode));
        return {
          ...item,
          chapterId: chapterIds.get(normalizeCode(chapter.code)),
          databaseItemCode: existing ? existing.item_code : item.itemCode,
        };
      }));
      await insertMany(client, 'standard_items',
        [ 'standard_version_id', 'chapter_id', 'item_code', 'title', 'content' ],
        items.map(item => [
          versionId, item.chapterId, item.databaseItemCode, item.title || null, item.content,
        ]),
        {
          onConflict: `ON CONFLICT (standard_version_id, item_code) DO UPDATE SET
            chapter_id = EXCLUDED.chapter_id, title = EXCLUDED.title, content = EXCLUDED.content`,
          returning: 'id, item_code',
        });
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
               'itemCode', si.item_code, 'title', si.title, 'content', si.content,
               'sourcePageFrom', si.source_page_from, 'sourcePageTo', si.source_page_to
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

  async createItem({ versionId, chapterId, itemCode, title, content }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
      INSERT INTO standard_items
        (standard_version_id, chapter_id, item_code, title, content)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *`, [ versionId, chapterId, itemCode, title || null, content ]);
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
            (standard_version_id, chapter_id, item_code, title, content)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (standard_version_id, item_code) DO UPDATE SET
            chapter_id = EXCLUDED.chapter_id, title = EXCLUDED.title, content = EXCLUDED.content`,
        [ versionId, chapterId, row.itemCode, row.title || null, row.content ]);
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

}

module.exports = StandardCatalogRepository;
