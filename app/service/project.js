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

  async listActiveUsers() {
    return this.repository.listActiveUsers();
  }

  async createProject(payload) {
    const name = String(payload.name || '').trim();
    if (!name) this.ctx.throw(400, '项目名称不能为空');
    if (name.length > 200) this.ctx.throw(400, '项目名称不能超过 200 个字符');
    try {
      return await this.repository.createProject({
        name,
        projectManagerId: payload.projectManagerId || null,
        sourceProjectId: payload.sourceProjectId || null,
      });
    } catch (error) {
      if (error.code === 'INVALID_SOURCE_PROJECT') this.ctx.throw(409, error.message);
      throw error;
    }
  }

  async getProjectDetail(projectId) {
    const result = await this.repository.getProjectDetail(projectId);
    if (!result) this.ctx.throw(404, '项目不存在');
    return result;
  }

  async getProjectManageDetail(projectId) {
    const result = await this.repository.getProjectManageDetail(projectId);
    if (!result) this.ctx.throw(404, '项目不存在');
    return result;
  }

  async updateProjectName(projectId, payload) {
    const name = String(payload.name || '').trim();
    if (!name) this.ctx.throw(400, '项目名称不能为空');
    if (name.length > 200) this.ctx.throw(400, '项目名称不能超过 200 个字符');
    const result = await this.repository.updateProjectName(projectId, name);
    if (!result) this.ctx.throw(404, '项目不存在');
    return result;
  }

  async setProjectMember(projectId, payload) {
    const userId = String(payload.userId || '').trim();
    const roleCode = String(payload.roleCode || '').trim();
    if (!userId) this.ctx.throw(400, '请选择用户');
    try {
      return await this.repository.setProjectMember({ projectId, userId, roleCode });
    } catch (error) {
      if ([ 'INVALID_MEMBER', 'INVALID_ROLE' ].includes(error.code)) this.ctx.throw(400, error.message);
      throw error;
    }
  }

  async removeProjectMember(projectId, userId) {
    if (String(userId) === String(this.ctx.session.userId)) this.ctx.throw(400, '不能移除当前登录账号的项目角色');
    try {
      await this.repository.removeProjectMember(projectId, userId);
    } catch (error) {
      if (error.code === 'CURRENT_MANAGER') this.ctx.throw(400, error.message);
      throw error;
    }
  }

  async setProjectManager(projectId, userId) {
    const managerId = String(userId || '').trim();
    if (!managerId) this.ctx.throw(400, '请选择项目管理员');
    try {
      await this.repository.setProjectManager(projectId, managerId);
    } catch (error) {
      if (error.code === 'INVALID_MANAGER') this.ctx.throw(400, error.message);
      throw error;
    }
  }

  async replaceChapterResponsibilities(projectId, chapterId, value, assignedBy) {
    const values = Array.isArray(value) ? value : [ value ];
    try {
      return await this.repository.replaceChapterResponsibilities({
        projectId,
        chapterId,
        userIds: [ ...new Set(values.map(item => String(item || '').trim()).filter(Boolean)) ],
        assignedBy,
      });
    } catch (error) {
      if (error.code === 'INVALID_CHAPTER') this.ctx.throw(400, error.message);
      throw error;
    }
  }

  async replaceProjectCloudCenters(projectId, value, ownerUserId) {
    const values = Array.isArray(value) ? value : [ value ];
    return this.repository.replaceProjectCloudCenters({
      projectId,
      cloudCenterIds: [ ...new Set(values.map(item => String(item || '').trim()).filter(Boolean)) ],
      ownerUserId,
    });
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
