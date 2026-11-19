'use strict';

const Service = require('egg').Service;
const { buildSupervisionPlanTemplate, parseSupervisionPlanFile } = require('../lib/supervisionPlanImport');
const { SupervisionPlanImportRepository } = require('../repository/supervisionPlanImport');

class SupervisionPlanImportService extends Service {
  get repository() {
    return new SupervisionPlanImportRepository(this.ctx.app.db);
  }

  async template() {
    return buildSupervisionPlanTemplate();
  }

  async createJob(filePath, fileName, createdBy) {
    const parsed = await parseSupervisionPlanFile(filePath, fileName);
    return this.repository.createJob({
      fileName: String(fileName || '检查方案.xlsx').slice(0, 500),
      payload: parsed,
      createdBy,
    });
  }

  async getReview(jobId) {
    const result = await this.repository.getReview(jobId);
    if (!result) this.ctx.throw(404, '检查方案导入任务不存在');
    return result;
  }

  async apply(jobId, actorId) {
    try {
      return await this.repository.apply(jobId, actorId);
    } catch (error) {
      if ([
        'SUPERVISION_IMPORT_NOT_FOUND',
        'SUPERVISION_IMPORT_NOT_READY',
        'SUPERVISION_IMPORT_STANDARD_MISMATCH',
      ].includes(error.code)) this.ctx.throw(409, error.message);
      throw error;
    }
  }
}

module.exports = SupervisionPlanImportService;
