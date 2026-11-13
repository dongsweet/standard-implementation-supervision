'use strict';

const Controller = require('egg').Controller;
const { requireProject, requireProjectAdmin } = require('../lib/authorization');

class ProjectWorkbookImportController extends Controller {
  async create() {
    const projectId = this.ctx.params.projectId;
    requireProjectAdmin(this.ctx, projectId);
    try {
      const file = (this.ctx.request.files || []).find(item => item.fieldname === 'file');
      if (!file) this.ctx.throw(400, '请选择项目整理工作簿');
      const job = await this.ctx.service.projectWorkbookImport.createJob(projectId, file.filepath, file.filename, this.ctx.session.userId);
      this.ctx.redirect(`/projects/${projectId}/data-imports/${job.id}`);
    } catch (error) {
      if ([ 400, 409 ].includes(error.status)) {
        this.ctx.redirect(`/projects/${projectId}/manage?notice=${encodeURIComponent('项目数据导入失败：' + error.message)}`);
        return;
      }
      throw error;
    } finally {
      await this.ctx.cleanupRequestFiles();
    }
  }

  async review() {
    const projectId = this.ctx.params.projectId;
    requireProject(this.ctx, projectId);
    const review = await this.ctx.service.projectWorkbookImport.getReview(projectId, this.ctx.params.jobId);
    await this.ctx.render('projects/data-import-review', {
      title: `项目数据导入 · ${review.job.original_filename}`,
      project: this.ctx.state.projects.find(item => item.id === projectId) || this.ctx.state.currentProject,
      ...review,
      csrf: this.ctx.csrf,
    });
  }

  async apply() {
    const projectId = this.ctx.params.projectId;
    requireProjectAdmin(this.ctx, projectId);
    try {
      const result = await this.ctx.service.projectWorkbookImport.apply(projectId, this.ctx.params.jobId, this.ctx.request.body || {}, this.ctx.session.userId);
      const notice = `项目数据已导入：匹配${result.matchedCount}条，应答${result.answerCount}条，云中心应答${result.cloudAnswerCount}条，监督定义${result.definitionCount}条，检查记录${result.executionCount}条`
        + (result.unmatchedCount ? `，未匹配${result.unmatchedCount}条` : '');
      this.ctx.redirect(`/projects/${projectId}/manage?notice=${encodeURIComponent(notice)}`);
    } catch (error) {
      if ([ 400, 409 ].includes(error.status)) {
        this.ctx.redirect(`/projects/${projectId}/data-imports/${this.ctx.params.jobId}?notice=${encodeURIComponent('暂不能导入：' + error.message)}`);
        return;
      }
      throw error;
    }
  }
}

module.exports = ProjectWorkbookImportController;
