'use strict';

class SystemSettingRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async getMany(keys) {
    if (!keys.length) return new Map();
    const result = await this.pool.query(`
      SELECT key, value, is_secret, updated_at
      FROM system_settings WHERE key = ANY($1::text[])`, [ keys ]);
    return new Map(result.rows.map(row => [ row.key, row ]));
  }

  async setMany(entries, userId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const entry of entries) {
        await client.query(`
          INSERT INTO system_settings (key, value, is_secret, updated_by, updated_at)
          VALUES ($1, $2, $3, $4, now())
          ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value,
            is_secret = EXCLUDED.is_secret,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()`, [ entry.key, entry.value ?? null, entry.isSecret === true, userId || null ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = SystemSettingRepository;
