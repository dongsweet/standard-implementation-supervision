'use strict';

const Service = require('egg').Service;
const { normalizeDefinition } = require('../lib/dedupe');
const Repository = require('../repository/supervisionDefinition');

class SupervisionDefinitionService extends Service {
  get repository() {
    return new Repository(this.ctx.app.db);
  }

  async list() {
    const [ definitions, standardItems ] = await Promise.all([
      this.repository.listDefinitions(),
      this.repository.listStandardItems(),
    ]);
    return { definitions, standardItems };
  }

  normalize(payload) {
    const fields = {
      object_name: String(payload.objectName || '').trim(),
      object_category: String(payload.objectCategory || '').trim(),
      check_layer: String(payload.checkLayer || '').trim(),
      check_method: String(payload.checkMethod || '').trim(),
      description: String(payload.description || '').trim(),
      steps: String(payload.steps || '').trim(),
      frequency: String(payload.frequency || '').trim(),
      access_mode: String(payload.accessMode || '').trim(),
    };
    if (!fields.object_name || !fields.check_method || !fields.description) this.ctx.throw(400, '检查对象、检查方法和检查描述不能为空');
    if (fields.object_name.length > 500 || fields.check_method.length > 2000 || fields.description.length > 5000) this.ctx.throw(400, '监督定义字段长度超出限制');
    const itemIds = Array.isArray(payload.standardItemIds) ? payload.standardItemIds : [ payload.standardItemIds ];
    const standardItemIds = [ ...new Set(itemIds.map(item => String(item || '').trim()).filter(Boolean)) ];
    return {
      fields: {
        objectName: fields.object_name,
        objectCategory: fields.object_category,
        checkLayer: fields.check_layer,
        checkMethod: fields.check_method,
        description: fields.description,
        steps: fields.steps,
        frequency: fields.frequency,
        accessMode: fields.access_mode,
        normalizedHash: normalizeDefinition(fields).normalizedHash,
      },
      standardItemIds,
    };
  }

  async create(payload) {
    try {
      return await this.repository.create(this.normalize(payload));
    } catch (error) {
      throw error;
    }
  }

  async update(id, payload) {
    const result = await this.repository.update(id, this.normalize(payload));
    if (!result) this.ctx.throw(404, '监督定义不存在或已归并');
    return result;
  }
}

module.exports = SupervisionDefinitionService;
