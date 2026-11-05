'use strict';

const Service = require('egg').Service;
const ProjectRepository = require('../repository/project');

const ANSWER_STATUSES = new Set([ 'unassessed', 'satisfied', 'partially_satisfied', 'not_satisfied', 'not_applicable' ]);

class ProjectService extends Service {
  get repository() {
    return new ProjectRepository(this.ctx.app.db);
  }

  async listProjects(userId = this.ctx.session.userId) {
    return this.repository.listProjects(userId);
  }

  async listPublishedVersions() {
    return this.repository.listPublishedVersions();
  }

  async createProject(payload) {
    const code = String(payload.code || '').trim();
    const name = String(payload.name || '').trim();
    if (!code || !name) this.ctx.throw(400, '项目编号和项目名称不能为空');
    try {
      return await this.repository.createProject({
        code,
        name,
        projectManagerId: payload.projectManagerId || null,
        sourceProjectId: payload.sourceProjectId || null,
        isTemplate: payload.isTemplate === true || payload.isTemplate === 'true' || payload.isTemplate === 'on',
      });
    } catch (error) {
      if (error.code === '23505') this.ctx.throw(409, '项目编号已存在');
      if (error.code === 'INVALID_TEMPLATE') this.ctx.throw(409, error.message);
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

  async switchProject(projectId) {
    const projects = this.ctx.state.projects || [];
    const project = projects.find(item => item.id === projectId);
    if (!project) this.ctx.throw(403, '无权访问此项目');
    this.ctx.session.currentProjectId = project.id;
    await this.ctx.app.db.query('UPDATE users SET last_project_id = $1, updated_at = now() WHERE id = $2', [ project.id, this.ctx.session.userId ]);
    return project;
  }
}

module.exports = ProjectService;
