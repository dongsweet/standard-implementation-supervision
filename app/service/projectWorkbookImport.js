'use strict';

const Service = require('egg').Service;
const { parseProjectWorkbookFile } = require('../lib/projectWorkbookImport');
const { ProjectWorkbookImportRepository } = require('../repository/projectWorkbookImport');

class ProjectWorkbookImportService extends Service {
  get repository() {
    return new ProjectWorkbookImportRepository(this.ctx.app.db);
  }

  async createJob(projectId, filePath, fileName, createdBy) {
    const parsed = await parseProjectWorkbookFile(filePath, fileName);
    return this.repository.createJob({
      projectId,
      fileName: String(fileName || '项目数据.xlsx').slice(0, 500),
      payload: parsed,
      createdBy,
    });
  }

  async getReview(projectId, jobId) {
    const result = await this.repository.getReview(projectId, jobId);
    if (!result) this.ctx.throw(404, '项目数据导入任务不存在');
    return result;
  }

  async apply(projectId, jobId, payload, actorId) {
    const value = payload.cloudCenterIds;
    const cloudCenterIds = Array.isArray(value) ? value : [ value ];
    try {
      return await this.repository.apply({
        projectId,
        jobId,
        cloudCenterIds: cloudCenterIds.map(item => String(item || '').trim() || null),
        acknowledgeUnmatched: payload.acknowledgeUnmatched === 'true' || payload.acknowledgeUnmatched === 'on',
        acknowledgeContentDifferences: payload.acknowledgeContentDifferences === 'true' || payload.acknowledgeContentDifferences === 'on',
        actorId,
      });
    } catch (error) {
      if ([ 'PROJECT_IMPORT_NOT_FOUND', 'PROJECT_IMPORT_NOT_READY', 'PROJECT_IMPORT_INVALID_CENTER_MAPPING', 'PROJECT_IMPORT_UNMATCHED', 'PROJECT_IMPORT_CONTENT_DIFFERENCE', 'PROJECT_IMPORT_NO_MATCH' ].includes(error.code)) {
        this.ctx.throw(409, error.message);
      }
      throw error;
    }
  }
}

module.exports = ProjectWorkbookImportService;
