'use strict';

const Controller = require('egg').Controller;
const { requireProject } = require('../lib/authorization');

class SupervisionExecutionController extends Controller {
  async index() {
    const project = this.ctx.state.currentProject;
    if (!project) {
      await this.ctx.render('projects/overview-empty', { title: '检查记录', csrf: this.ctx.csrf });
      return;
    }
    requireProject(this.ctx, project.id);
    await this.ctx.render('supervision-executions/index', {
      title: '检查记录 · ' + project.name,
      project,
      ...await this.ctx.service.supervisionExecution.list(project.id),
      csrf: this.ctx.csrf,
    });
  }

  async create() {
    const projectId = this.ctx.params.projectId;
    requireProject(this.ctx, projectId, true);
    await this.ctx.service.supervisionExecution.create(projectId, this.ctx.request.body || {}, this.ctx.session.userId);
    this.ctx.redirect('/supervision-executions?notice=' + encodeURIComponent('检查记录已创建'));
  }
}

module.exports = SupervisionExecutionController;
