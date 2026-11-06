'use strict';

class CloudCenterRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listAll() {
    const result = await this.pool.query(`
      SELECT cc.id, cc.code, cc.name, cc.center_type,
             count(pcc.project_id)::integer AS project_count
      FROM cloud_centers cc
      LEFT JOIN project_cloud_centers pcc ON pcc.cloud_center_id = cc.id
      GROUP BY cc.id
      ORDER BY cc.name, cc.code`);
    return result.rows;
  }

  async create({ code, name, centerType }) {
    const result = await this.pool.query(`
      INSERT INTO cloud_centers (code, name, center_type)
      VALUES ($1, $2, $3)
      RETURNING id, code, name, center_type`, [ code, name, centerType || null ]);
    return result.rows[0];
  }

  async update(id, { code, name, centerType }) {
    const result = await this.pool.query(`
      UPDATE cloud_centers
      SET code = $2, name = $3, center_type = $4
      WHERE id = $1
      RETURNING id, code, name, center_type`, [ id, code, name, centerType || null ]);
    return result.rows[0] || null;
  }
}

module.exports = CloudCenterRepository;
