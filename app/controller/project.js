'use strict';

const Controller = require('egg').Controller;
const { requireGlobalWrite, requireProject } = require('../lib/authorization');

class ProjectController extends Controller {
  async index() {
    const projects = await this.ctx.service.project.listProjects();
    await this.ctx.render('projects/index', {
      title: '项目与标准基线',
      projects,
      templates: projects.filter(project => project.is_template),
      versions: await this.ctx.service.project.listPublishedVersions(),
      csrf: this.ctx.csrf,
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
    const versions = await this.ctx.service.project.listPublishedVersions();
    await this.ctx.render('projects/detail', { title: `${detail.project.code} · ${detail.project.name}`, ...detail, versions, versionsInProject: detail.versions, csrf: this.ctx.csrf });
  }

  async switchProject() {
    await this.ctx.service.project.switchProject(String(this.ctx.request.body.projectId || ''));
    const returnTo = String(this.ctx.request.body.returnTo || '/').trim();
    this.ctx.redirect(returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
  }

  async attachVersion() {
    requireProject(this.ctx, this.ctx.params.projectId, true);
    await this.ctx.service.project.attachVersion(this.ctx.params.projectId, this.ctx.request.body.versionId);
    this.ctx.redirect(`/projects/${this.ctx.params.projectId}`);
  }

  async saveAnswer() {
    requireProject(this.ctx, this.ctx.params.projectId, true);
    await this.ctx.service.project.saveAnswer(this.ctx.params.projectId, this.ctx.params.standardItemId, this.ctx.request.body || {}, this.ctx.session.userId);
    this.ctx.redirect(`/projects/${this.ctx.params.projectId}`);
  }
}

module.exports = ProjectController;
