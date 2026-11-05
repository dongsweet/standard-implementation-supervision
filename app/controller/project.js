'use strict';

const Controller = require('egg').Controller;
const { requireGlobalWrite, requireProject, requireProjectAdmin } = require('../lib/authorization');

class ProjectController extends Controller {
  async index() {
    const projects = await this.ctx.service.project.listProjects();
    await this.ctx.render('projects/index', {
      title: '项目管理',
      projects,
      templates: projects.filter(project => project.is_template),
      versions: await this.ctx.service.project.listPublishedVersions(),
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
      title: `${detail.project.code} · ${detail.project.name}`,
      ...detail,
      versionsInProject: detail.versions,
      csrf: this.ctx.csrf,
      isOverview: true,
    });
  }

  async create() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.project.createProject(this.ctx.request.body || {});
    this.ctx.redirect('/projects');
  }

  async detail() {
    requireProject(this.ctx, this.ctx.params.projectId);
    const detail = await this.ctx.service.project.getProjectDetail(this.ctx.params.projectId);
    await this.ctx.render('projects/detail', { title: `${detail.project.code} · ${detail.project.name}`, ...detail, versionsInProject: detail.versions, csrf: this.ctx.csrf });
  }

  async manage() {
    requireProjectAdmin(this.ctx, this.ctx.params.projectId);
    const detail = await this.ctx.service.project.getProjectManageDetail(this.ctx.params.projectId);
    await this.ctx.render('projects/manage', {
      title: `项目管理 · ${detail.project.code}`,
      ...detail,
      csrf: this.ctx.csrf,
    });
  }

  async addMember() {
    requireProjectAdmin(this.ctx, this.ctx.params.projectId);
    await this.ctx.service.project.setProjectMember(this.ctx.params.projectId, this.ctx.request.body || {});
    this.ctx.redirect(`/projects/${this.ctx.params.projectId}/manage`);
  }

  async removeMember() {
    requireProjectAdmin(this.ctx, this.ctx.params.projectId);
    await this.ctx.service.project.removeProjectMember(this.ctx.params.projectId, this.ctx.params.userId);
    this.ctx.redirect(`/projects/${this.ctx.params.projectId}/manage`);
  }

  async setManager() {
    requireProjectAdmin(this.ctx, this.ctx.params.projectId);
    await this.ctx.service.project.setProjectManager(this.ctx.params.projectId, this.ctx.request.body.userId);
    this.ctx.redirect(`/projects/${this.ctx.params.projectId}/manage`);
  }

  async saveChapterResponsibilities() {
    requireProjectAdmin(this.ctx, this.ctx.params.projectId);
    await this.ctx.service.project.replaceChapterResponsibilities(
      this.ctx.params.projectId,
      this.ctx.params.chapterId,
      this.ctx.request.body.userIds,
      this.ctx.session.userId,
    );
    this.ctx.redirect(`/projects/${this.ctx.params.projectId}/manage`);
  }

  async switchProject() {
    await this.ctx.service.project.switchProject(String(this.ctx.request.body.projectId || ''));
    const returnTo = String(this.ctx.request.body.returnTo || '/').trim();
    this.ctx.redirect(returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
  }

  async saveAnswer() {
    requireProject(this.ctx, this.ctx.params.projectId, true);
    await this.ctx.service.project.saveAnswer(this.ctx.params.projectId, this.ctx.params.standardItemId, this.ctx.request.body || {}, this.ctx.session.userId);
    this.ctx.redirect(`/projects/${this.ctx.params.projectId}`);
  }
}

module.exports = ProjectController;
