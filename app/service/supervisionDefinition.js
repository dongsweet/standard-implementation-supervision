'use strict';

const Service = require('egg').Service;
const { normalizeDefinition } = require('../lib/dedupe');
const { DEFAULT_SUPERVISION_METHODS, joinSupervisionMethods, splitSupervisionMethods } = require('../lib/supervisionMethods');
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
    const checkMethodOptions = new Set(DEFAULT_SUPERVISION_METHODS);
    for (const definition of definitions) {
      splitSupervisionMethods(definition.check_method).forEach(method => checkMethodOptions.add(method));
    }
    return { definitions, standardItems, checkMethodOptions: [ ...checkMethodOptions ] };
  }

  normalize(payload) {
    const checkMethod = joinSupervisionMethods([
      payload.checkMethods,
      payload.checkMethod,
      payload.additionalCheckMethods,
    ]);
    const fields = {
      object_name: String(payload.objectName || '').trim(),
      scope: String(payload.scope || '').trim(),
      recognized_object: payload.recognizedObject === '' || payload.recognizedObject === undefined
        ? null
        : payload.recognizedObject === true || payload.recognizedObject === 'true' || payload.recognizedObject === '是',
      object_category: String(payload.objectCategory || '').trim(),
      check_layer: String(payload.checkLayer || '').trim(),
      check_method: checkMethod,
      description: String(payload.description || '').trim(),
      steps: String(payload.steps || '').trim(),
      frequency: String(payload.frequency || '').trim(),
      access_mode: String(payload.accessMode || '').trim(),
      priority: String(payload.priority || '').trim(),
      reference_result: String(payload.referenceResult || '').trim(),
      reference_materials: String(payload.referenceMaterials || '').trim(),
    };
    if (payload.recognizedObject && ![ true, 'true', 'false', '是', '否' ].includes(payload.recognizedObject)) {
      this.ctx.throw(400, '是否公认对象只能填写“是”或“否”');
    }
    if (fields.priority && ![ '重点项', '非重点项' ].includes(fields.priority)) this.ctx.throw(400, '重点项只能填写“重点项”或“非重点项”');
    if (!fields.object_name || !fields.check_method || !fields.description) this.ctx.throw(400, '检查对象、检查方法和检查描述不能为空');
    if (fields.object_name.length > 500 || fields.scope.length > 200 || fields.check_method.length > 2000 || fields.description.length > 5000) this.ctx.throw(400, '监督定义字段长度超出限制');
    const itemIds = Array.isArray(payload.standardItemIds) ? payload.standardItemIds : [ payload.standardItemIds ];
    const standardItemIds = [ ...new Set(itemIds.map(item => String(item || '').trim()).filter(Boolean)) ];
    return {
      fields: {
        objectName: fields.object_name,
        scope: fields.scope,
        recognizedObject: fields.recognized_object,
        objectCategory: fields.object_category,
        checkLayer: fields.check_layer,
        checkMethod: fields.check_method,
        description: fields.description,
        steps: fields.steps,
        frequency: fields.frequency,
        accessMode: fields.access_mode,
        priority: fields.priority,
        referenceResult: fields.reference_result,
        referenceMaterials: fields.reference_materials,
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
