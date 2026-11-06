'use strict';

const Service = require('egg').Service;
const Repository = require('../repository/supervisionExecution');

const RESULTS = new Set([ 'unassessed', 'satisfied', 'partially_satisfied', 'not_satisfied', 'not_applicable' ]);
const OVERALL_RESULTS = new Set([ 'satisfied', 'partially_satisfied', 'not_satisfied' ]);

class SupervisionExecutionService extends Service {
  get repository() {
    return new Repository(this.ctx.app.db);
  }

  async list(projectId) {
    const [ options, executions ] = await Promise.all([
      this.repository.listOptions(projectId),
      this.repository.list(projectId),
    ]);
    return { ...options, executions };
  }

  async create(projectId, payload, checkedBy) {
    const definitionId = String(payload.definitionId || '').trim();
    const cloudCenterId = String(payload.cloudCenterId || '').trim() || null;
    const checkedAt = String(payload.checkedAt || '').trim();
    if (!definitionId || !checkedAt) this.ctx.throw(400, '请选择监督定义并填写检查时间');
    const overallResult = String(payload.overallResult || '').trim();
    if (overallResult && !OVERALL_RESULTS.has(overallResult)) this.ctx.throw(400, '无效的总体检查结论');
    let submitted = {};
    if (payload.itemResults) {
      try {
        submitted = JSON.parse(String(payload.itemResults));
      } catch {
        this.ctx.throw(400, '标准项检查结果格式无效');
      }
    }
    const itemResults = new Map();
    for (const [ standardItemId, item ] of Object.entries(submitted || {})) {
      if (!item || !RESULTS.has(item.result || 'unassessed')) this.ctx.throw(400, '无效的标准项检查结论');
      itemResults.set(standardItemId, {
        result: item.result || 'unassessed',
        description: String(item.description || '').trim(),
        problemDescription: String(item.problemDescription || '').trim(),
        rectificationDueAt: String(item.rectificationDueAt || '').trim() || null,
      });
    }
    try {
      return await this.repository.create({
        projectId, definitionId, cloudCenterId, checkedAt, checkedBy,
        overallResult, notes: String(payload.notes || '').trim(), itemResults,
      });
    } catch (error) {
      if ([ 'INVALID_DEFINITION', 'INVALID_CLOUD_CENTER' ].includes(error.code)) this.ctx.throw(400, error.message);
      throw error;
    }
  }
}

module.exports = SupervisionExecutionService;
