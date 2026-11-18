'use strict';

const Controller = require('egg').Controller;
const { buildProjectAnswerWorkbook } = require('../lib/projectAnswerTemplate');
const { canWriteProject, requireGlobalWrite, requireProject, requireProjectAdmin } = require('../lib/authorization');

class ProjectController extends Controller {
  async index() {
    const projects = await this.ctx.service.project.listProjects();
    await this.ctx.render('projects/index', {
      title: '项目管理',
      projects,
      activeUsers: await this.ctx.service.project.listActiveUsers(),
      csrf: this.ctx.csrf,
    });
  }

  async overview() {
    const currentProject = this.ctx.state.currentProject;
    if (!currentProject) {
      await this.ctx.render('projects/overview-empty', { title: '项目总览', csrf: this.ctx.csrf });
      return;
    }
    requireProject(this.ctx, currentProject.id);
    const detail = await this.ctx.service.project.getProjectDetail(currentProject.id);
    await this.ctx.render('projects/detail', {
      title: '项目总览',
      ...detail,
      versionsInProject: detail.versions,
      csrf: this.ctx.csrf,
      isOverview: true,
    });
  }

  async answers() {
    const currentProject = this.ctx.state.currentProject;
    if (!currentProject) {
      await this.ctx.render('projects/overview-empty', { title: '章节应答', csrf: this.ctx.csrf });
      return;
    }
    requireProject(this.ctx, currentProject.id);
    const overview = await this.ctx.service.project.getProjectAnswerOverview(currentProject.id);
    await this.ctx.render('projects/answer-overview', {
      title: '章节应答',
      ...overview,
      csrf: this.ctx.csrf,
      canImport: canWriteProject(this.ctx.state.roles || [], currentProject.id),
    });
  }

  async standardAnswers() {
    const currentProject = this.ctx.state.currentProject;
    if (!currentProject) {
      await this.ctx.render('projects/overview-empty', { title: '章节应答', csrf: this.ctx.csrf });
      return;
    }
    requireProject(this.ctx, currentProject.id);
    const detail = await this.ctx.service.project.getProjectStandardAnswers(currentProject.id, this.ctx.params.standardVersionId, this.ctx.query);
    await this.ctx.render('projects/answer-standard', {
      title: `章节应答 · ${detail.project.standard_code} · ${detail.project.version}`,
      ...detail,
      csrf: this.ctx.csrf,
      canImport: canWriteProject(this.ctx.state.roles || [], currentProject.id),
    });
  }

  async create() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.project.createProject(this.ctx.request.body || {});
    this.ctx.redirect('/projects?notice=' + encodeURIComponent('项目已创建'));
  }

  async detail() {
    requireProject(this.ctx, this.ctx.params.projectId);
    const detail = await this.ctx.service.project.getProjectDetail(this.ctx.params.projectId);
    await this.ctx.render('projects/detail', { title: detail.project.name, ...detail, versionsInProject: detail.versions, csrf: this.ctx.csrf });
  }

  async manage() {
    requireProjectAdmin(this.ctx, this.ctx.params.projectId);
    const detail = await this.ctx.service.project.getProjectManageDetail(this.ctx.params.projectId);
    await this.ctx.render('projects/manage', {
      title: `项目管理 · ${detail.project.name}`,
      ...detail,
      csrf: this.ctx.csrf,
    });
  }

  async update() {
    requireProjectAdmin(this.ctx, this.ctx.params.projectId);
    await this.ctx.service.project.updateProjectName(this.ctx.params.projectId, this.ctx.request.body || {});
    this.ctx.redirect(`/projects/${this.ctx.params.projectId}/manage?notice=` + encodeURIComponent('项目名称已更新'));
  }

  async addMember() {
    requireProjectAdmin(this.ctx, this.ctx.params.projectId);
    await this.ctx.service.project.setProjectMember(this.ctx.params.projectId, this.ctx.request.body || {});
    this.ctx.redirect(`/projects/${this.ctx.params.projectId}/manage?notice=` + encodeURIComponent('项目成员已保存'));
  }

  async removeMember() {
    requireProjectAdmin(this.ctx, this.ctx.params.projectId);
    await this.ctx.service.project.removeProjectMember(this.ctx.params.projectId, this.ctx.params.userId);
    this.ctx.redirect(`/projects/${this.ctx.params.projectId}/manage?notice=` + encodeURIComponent('项目成员已移除'));
  }

  async setManager() {
    requireProjectAdmin(this.ctx, this.ctx.params.projectId);
    await this.ctx.service.project.setProjectManager(this.ctx.params.projectId, this.ctx.request.body.userId);
    this.ctx.redirect(`/projects/${this.ctx.params.projectId}/manage?notice=` + encodeURIComponent('项目管理员已更新'));
  }

  async saveChapterResponsibilities() {
    requireProjectAdmin(this.ctx, this.ctx.params.projectId);
    await this.ctx.service.project.replaceChapterResponsibilities(
      this.ctx.params.projectId,
      this.ctx.params.chapterId,
      this.ctx.request.body.userIds,
      this.ctx.session.userId,
    );
    this.ctx.redirect(`/projects/${this.ctx.params.projectId}/manage?notice=` + encodeURIComponent('章节负责人已保存'));
  }

  async addStandardVersion() {
    requireProjectAdmin(this.ctx, this.ctx.params.projectId);
    await this.ctx.service.project.addProjectStandardVersion(
      this.ctx.params.projectId,
      this.ctx.request.body.standardVersionId
    );
    this.ctx.redirect(`/projects/${this.ctx.params.projectId}/manage?notice=` + encodeURIComponent('规范版本已纳入项目基线'));
  }

  async syncStandardVersion() {
    const { projectId, standardVersionId } = this.ctx.params;
    requireProjectAdmin(this.ctx, projectId);
    try {
      const result = await this.ctx.service.project.syncProjectStandardVersion(
        projectId,
        standardVersionId,
        this.ctx.session.userId,
      );
      const notice = `同步完成：新增${result.addedCount}项，更新${result.updatedCount}项，${result.unchangedCount}项无变化`;
      this.ctx.redirect(`/projects/${projectId}/manage?notice=` + encodeURIComponent(notice));
    } catch (error) {
      if ([ 400, 404, 409 ].includes(error.status)) {
        this.ctx.redirect(`/projects/${projectId}/manage?notice=` + encodeURIComponent('同步失败：' + error.message));
        return;
      }
      throw error;
    }
  }

  async saveCloudCenters() {
    requireProjectAdmin(this.ctx, this.ctx.params.projectId);
    await this.ctx.service.project.replaceProjectCloudCenters(
      this.ctx.params.projectId,
      this.ctx.request.body.cloudCenterIds,
      this.ctx.session.userId,
    );
    this.ctx.redirect(`/projects/${this.ctx.params.projectId}/manage?notice=` + encodeURIComponent('项目云中心已保存'));
  }

  async switchProject() {
    await this.ctx.service.project.switchProject(String(this.ctx.request.body.projectId || ''));
    const returnTo = String(this.ctx.request.body.returnTo || '/').trim();
    this.ctx.redirect(returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
  }

  async downloadAnswerTemplate() {
    const projectId = this.ctx.params.projectId;
    requireProject(this.ctx, projectId);
    const project = (this.ctx.state.projects || []).find(item => item.id === projectId) || this.ctx.state.currentProject;
    if (!project) this.ctx.throw(404, '项目不存在');
    const rows = await this.ctx.service.project.listAnswerTemplateRows(projectId);
    const workbook = await buildProjectAnswerWorkbook({ rows });
    const safeName = String(project.name || '项目').replace(/[\\/:*?"<>|]/g, '_');
    this.ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    this.ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName}-应答导入模板.xlsx`)}`);
    this.ctx.body = workbook;
  }

  async saveAnswer() {
    requireProject(this.ctx, this.ctx.params.projectId, true);
    await this.ctx.service.project.saveAnswer(this.ctx.params.projectId, this.ctx.params.standardItemId, this.ctx.request.body || {}, this.ctx.session.userId);
    const requestedReturnTo = String((this.ctx.request.body || {}).returnTo || '');
    const returnTo = requestedReturnTo.startsWith('/') && !requestedReturnTo.startsWith('//')
      ? requestedReturnTo
      : `/projects/${this.ctx.params.projectId}`;
    this.ctx.redirect(returnTo + (returnTo.includes('?') ? '&' : '?') + 'notice=' + encodeURIComponent('章节应答已保存'));
  }
}

module.exports = ProjectController;
