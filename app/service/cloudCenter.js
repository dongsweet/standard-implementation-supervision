'use strict';

const Service = require('egg').Service;
const CloudCenterRepository = require('../repository/cloudCenter');

class CloudCenterService extends Service {
  get repository() {
    return new CloudCenterRepository(this.ctx.app.db);
  }

  async listAll() {
    return this.repository.listAll();
  }

  normalize(payload) {
    const code = String(payload.code || '').trim();
    const name = String(payload.name || '').trim();
    const centerType = String(payload.centerType || '').trim();
    if (!code || !name) this.ctx.throw(400, '云中心编码和名称不能为空');
    if (code.length > 100) this.ctx.throw(400, '云中心编码不能超过 100 个字符');
    if (name.length > 200) this.ctx.throw(400, '云中心名称不能超过 200 个字符');
    return { code, name, centerType: centerType.slice(0, 50) || null };
  }

  async create(payload) {
    try {
      return await this.repository.create(this.normalize(payload));
    } catch (error) {
      if (error.code === '23505') this.ctx.throw(409, '云中心编码已存在');
      throw error;
    }
  }

  async update(id, payload) {
    try {
      const result = await this.repository.update(id, this.normalize(payload));
      if (!result) this.ctx.throw(404, '云中心不存在');
      return result;
    } catch (error) {
      if (error.code === '23505') this.ctx.throw(409, '云中心编码已存在');
      throw error;
    }
  }
}

module.exports = CloudCenterService;
