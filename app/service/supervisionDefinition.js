'use strict';

const Service = require('egg').Service;
const { normalizeDefinition } = require('../lib/dedupe');
const { DEFAULT_SUPERVISION_METHODS, joinSupervisionMethods, splitSupervisionMethods } = require('../lib/supervisionMethods');
const { DEFAULT_SUPERVISION_CENTERS, splitSupervisionCenters } = require('../lib/supervisionCenters');
const Repository = require('../repository/supervisionDefinition');

// PostgreSQL accepts UUIDs with any version/variant bits; validate the shape only.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class SupervisionDefinitionService extends Service {
  get repository() {
    return new Repository(this.ctx.app.db);
  }

  async list(query = {}) {
    const search = String(query.search || '').trim().slice(0, 100);
    const status = String(query.status || '').trim();
    const priority = String(query.priority || '').trim();
    const checkMethod = String(query.checkMethod || '').trim().slice(0, 100);
    const center = String(query.center || '').trim();
    const allowedStatuses = new Set([ '', 'active', 'merged' ]);
    const allowedPriorities = new Set([ '', '重点项', '非重点项', '未指定' ]);
    if (!allowedStatuses.has(status)) this.ctx.throw(400, '无效的方案状态');
    if (!allowedPriorities.has(priority)) this.ctx.throw(400, '无效的重点项筛选');
    const pageSize = 20;
    const requestedPage = Number.parseInt(query.page, 10);
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const [ definitionResult, standardItems, methodRows, centers ] = await Promise.all([
      this.repository.listDefinitions({ search, status, priority, checkMethod, center, page, pageSize }),
      this.repository.listStandardItems(),
      this.repository.listDefinitionMethods(),
      this.repository.listDefinitionCenters(),
    ]);
    const checkMethodOptions = new Set(DEFAULT_SUPERVISION_METHODS);
    for (const methodValue of methodRows) {
      splitSupervisionMethods(methodValue).forEach(method => checkMethodOptions.add(method));
    }
    return {
      definitions: definitionResult.rows,
      standardItems,
      checkMethodOptions: [ ...checkMethodOptions ].sort((left, right) => left.localeCompare(right, 'zh-CN')),
      centers,
      centerOptions: DEFAULT_SUPERVISION_CENTERS,
      total: definitionResult.total,
      page: definitionResult.page,
      pageSize,
      pageCount: definitionResult.pageCount,
      search,
      status,
      priority,
      checkMethod,
      center,
    };
  }

  async listCenterObjects(query = {}) {
    const center = String(query.center || '').trim();
    const search = String(query.search || '').trim().slice(0, 100);
    if (center && !DEFAULT_SUPERVISION_CENTERS.includes(center)) this.ctx.throw(400, '无效的检查中心筛选');
    const pageSize = 20;
    const requestedPage = Number.parseInt(query.page, 10);
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const result = await this.repository.listCenterObjects({ center, search, page, pageSize });
    return {
      center,
      search,
      centerOptions: DEFAULT_SUPERVISION_CENTERS,
      centerObjects: result.rows,
      total: result.total,
      page: result.page,
      pageSize,
      pageCount: result.pageCount,
    };
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
      centers: splitSupervisionCenters(payload.centers),
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
    if (fields.object_name.length > 500 || fields.scope.length > 200 || fields.object_category.length > 200 || fields.check_layer.length > 200
      || fields.check_method.length > 2000 || fields.description.length > 5000 || fields.frequency.length > 100
      || fields.access_mode.length > 50 || fields.priority.length > 50) this.ctx.throw(400, '监督定义字段长度超出限制');
    if (fields.centers.some(center => !DEFAULT_SUPERVISION_CENTERS.includes(center))) this.ctx.throw(400, '适用检查中心只能选择云中心、统一运维中心或总部');
    if (!fields.centers.length) this.ctx.throw(400, '请至少选择一个适用检查中心');
    const itemIds = Array.isArray(payload.standardItemIds) ? payload.standardItemIds : [ payload.standardItemIds ];
    const standardItemIds = [ ...new Set(itemIds.map(item => String(item || '').trim()).filter(Boolean)) ];
    if (!standardItemIds.length) this.ctx.throw(400, '请至少关联一个标准项');
    if (standardItemIds.some(item => !UUID_RE.test(item))) this.ctx.throw(400, '标准项编号格式无效');
    return {
      fields: {
        objectName: fields.object_name,
        scope: fields.scope,
        centers: fields.centers,
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

  async create(payload, actorId) {
    const normalized = this.normalize(payload);
    try {
      return await this.repository.create(normalized, actorId);
    } catch (error) {
      if (error.code === 'INVALID_STANDARD_ITEMS') this.ctx.throw(400, error.message);
      throw error;
    }
  }

  async update(id, payload, actorId) {
    if (!UUID_RE.test(String(id || ''))) this.ctx.throw(400, '监督定义编号格式无效');
    let result;
    try {
      result = await this.repository.update(id, this.normalize(payload), actorId);
    } catch (error) {
      if (error.code === 'INVALID_STANDARD_ITEMS') this.ctx.throw(400, error.message);
      throw error;
    }
    if (!result) this.ctx.throw(404, '监督定义不存在或已归并');
    return result;
  }
}

module.exports = SupervisionDefinitionService;
