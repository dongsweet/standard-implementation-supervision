'use strict';

const { normalizeText } = require('../lib/dedupe');

class SupervisionObjectRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async ensure(client, name, categoryName = '') {
    const canonicalName = String(name || '').trim();
    if (!canonicalName) return null;
    const normalizedName = normalizeText(canonicalName).replace(/\s+/g, '');
    let categoryId = null;
    const category = String(categoryName || '').trim();
    if (category) {
      const categoryResult = await client.query(`
        INSERT INTO supervision_object_categories (name)
        VALUES ($1) ON CONFLICT (name) DO UPDATE SET updated_at = now()
        RETURNING id`, [ category ]);
      categoryId = categoryResult.rows[0]?.id || null;
    }
    const existing = await client.query(`
      SELECT id, category_id FROM supervision_objects
      WHERE canonical_name = $1 AND status = 'active'
      ORDER BY created_at, id LIMIT 1`, [ canonicalName ]);
    if (existing.rowCount) {
      if (categoryId && !existing.rows[0].category_id) {
        await client.query(`UPDATE supervision_objects SET category_id = $2, updated_at = now() WHERE id = $1`, [ existing.rows[0].id, categoryId ]);
      }
      return existing.rows[0].id;
    }
    const created = await client.query(`
      INSERT INTO supervision_objects (canonical_name, normalized_name, category_id)
      VALUES ($1, $2, $3) RETURNING id`, [ canonicalName, normalizedName, categoryId ]);
    return created.rows[0].id;
  }
}

module.exports = SupervisionObjectRepository;
