'use strict';

const Service = require('egg').Service;
const ProjectRepository = require('../repository/project');

const ANSWER_STATUSES = new Set([ 'unassessed', 'satisfied', 'partially_satisfied', 'not_satisfied', 'not_applicable' ]);

class ProjectService extends Service {
  get repository() {
    return new ProjectRepository(this.ctx.app.db);
  }

  async listProjects() {
    return this.repository.listProjects();
  }

  async listPublishedVersions() {
    return this.repository.listPublishedVersions();
  }

  async createProject(payload) {
    const code = String(payload.code || '').trim();
    const name = String(payload.name || '').trim();
    if (!code || !name) this.ctx.throw(400, '项目编号和项目名称不能为空');
    try {
      return await this.repository.createProject({ code, name, projectManagerId: payload.projectManagerId || null });
    } catch (error) {
      if (error.code === '23505') this.ctx.throw(409, '项目编号已存在');
      throw error;
    }
  }

  async getProjectDetail(projectId) {
    const result = await this.repository.getProjectDetail(projectId);
    if (!result) this.ctx.throw(404, '项目不存在');
    return result;
  }

  async attachVersion(projectId, versionId) {
    try {
      return await this.repository.attachVersion(projectId, versionId);
    } catch (error) {
      if (error.code === 'VERSION_NOT_PUBLISHED') this.ctx.throw(409, error.message);
      throw error;
    }
  }

  async saveAnswer(projectId, standardItemId, payload, ownerUserId) {
    const status = String(payload.status || 'unassessed');
    if (!ANSWER_STATUSES.has(status)) this.ctx.throw(400, '无效的应答状态');
    return this.repository.saveAnswer({
      projectId,
      standardItemId,
      status,
      measureDescription: payload.measureDescription,
      problemDescription: payload.problemDescription,
      ownerUserId,
    });
  }
}

module.exports = ProjectService;
