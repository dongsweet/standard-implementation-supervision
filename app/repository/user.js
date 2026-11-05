'use strict';

class UserRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listUsers() {
    const result = await this.pool.query(`
      SELECT u.id, u.username, u.display_name, u.is_active, u.created_at, u.updated_at,
             COALESCE((SELECT json_agg(json_build_object('code', r.code, 'name', r.name) ORDER BY r.code)
                       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                       WHERE ur.user_id = u.id AND ur.project_id IS NULL), '[]'::json) AS global_roles,
             (SELECT count(DISTINCT ur.project_id)::integer FROM user_roles ur WHERE ur.user_id = u.id AND ur.project_id IS NOT NULL) AS project_count
      FROM users u
      ORDER BY u.is_active DESC, u.username`);
    return result.rows;
  }

  async createUser({ username, displayName, passwordHash, globalRoleCodes = [] }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query(`
        INSERT INTO users (username, display_name, password_hash)
        VALUES ($1, $2, $3) RETURNING id, username, display_name, is_active`,
      [ username, displayName, passwordHash ]);
      for (const roleCode of globalRoleCodes) {
        await client.query(`
          INSERT INTO user_roles (user_id, role_id)
          SELECT $1, id FROM roles WHERE code = $2 AND scope = 'global'
          ON CONFLICT DO NOTHING`, [ created.rows[0].id, roleCode ]);
      }
      await client.query('COMMIT');
      return created.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async setActive(userId, isActive) {
    const result = await this.pool.query(`
      UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1
      RETURNING id, username, display_name, is_active`, [ userId, isActive ]);
    return result.rows[0] || null;
  }

  async resetPassword(userId, passwordHash) {
    const result = await this.pool.query(`
      UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1
      RETURNING id`, [ userId, passwordHash ]);
    return result.rows[0] || null;
  }

  async replaceGlobalRoles(userId, roleCodes) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        DELETE FROM user_roles ur USING roles r
        WHERE ur.role_id = r.id AND ur.user_id = $1 AND ur.project_id IS NULL AND r.scope = 'global'`, [ userId ]);
      for (const roleCode of roleCodes) {
        await client.query(`
          INSERT INTO user_roles (user_id, role_id)
          SELECT $1, id FROM roles WHERE code = $2 AND scope = 'global'
          ON CONFLICT DO NOTHING`, [ userId, roleCode ]);
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

module.exports = UserRepository;
