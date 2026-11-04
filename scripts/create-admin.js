'use strict';

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

async function main() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password || password.length < 12) throw new Error('请设置 ADMIN_USERNAME，且 ADMIN_PASSWORD 至少 12 位');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await pool.query(`
      INSERT INTO users (username, password_hash, display_name)
      VALUES ($1, $2, $1)
      ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash, is_active = true
      RETURNING id`, [ username, passwordHash ]);
    await pool.query(`
      INSERT INTO user_roles (user_id, role_id)
      SELECT $1, id FROM roles WHERE code = 'system_admin'
      ON CONFLICT DO NOTHING`, [ user.rows[0].id ]);
    process.stdout.write(`管理员账号已就绪: ${username}\n`);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
