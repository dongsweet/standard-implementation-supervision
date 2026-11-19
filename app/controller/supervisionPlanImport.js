'use strict';

const Controller = require('egg').Controller;
const { requireGlobalRead, requireGlobalWrite } = require('../lib/authorization');

class SupervisionPlanImportController extends Controller {
  async template() {
    requireGlobalRead(this.ctx);
    const buffer = await this.ctx.service.supervisionPlanImport.template();
    this.ctx.type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    this.ctx.attachment('检查方案导入模板.xlsx');
    this.ctx.body = buffer;
  }

  async create() {
    requireGlobalWrite(this.ctx);
    try {
      const file = (this.ctx.request.files || []).find(item => item.fieldname === 'file');
      if (!file) this.ctx.throw(400, '请选择检查方案工作簿');
      const job = await this.ctx.service.supervisionPlanImport.createJob(file.filepath, file.filename, this.ctx.session.userId);
      this.ctx.redirect(`/supervision-plan-imports/${job.id}`);
    } catch (error) {
      if ([ 400, 409 ].includes(error.status)) {
        this.ctx.redirect('/supervision-definitions?notice=' + encodeURIComponent('检查方案导入失败：' + error.message));
        return;
      }
      throw error;
    } finally {
      await this.ctx.cleanupRequestFiles();
    }
  }

  async review() {
    requireGlobalRead(this.ctx);
    const review = await this.ctx.service.supervisionPlanImport.getReview(this.ctx.params.jobId);
    await this.ctx.render('supervision-plan-imports/review', {
      title: `检查方案导入 · ${review.job.original_filename}`,
      ...review,
      csrf: this.ctx.csrf,
    });
  }

  async apply() {
    requireGlobalWrite(this.ctx);
    try {
      const result = await this.ctx.service.supervisionPlanImport.apply(this.ctx.params.jobId, this.ctx.session.userId);
      const notice = `检查方案导入完成：${result.importedRowCount}条方案，新增${result.createdCount}条，复用${result.reusedCount}条，关联${result.linkCount}个标准项`;
      this.ctx.redirect('/supervision-definitions?notice=' + encodeURIComponent(notice));
    } catch (error) {
      if ([ 400, 409 ].includes(error.status)) {
        this.ctx.redirect(`/supervision-plan-imports/${this.ctx.params.jobId}?notice=${encodeURIComponent('暂不能导入：' + error.message)}`);
        return;
      }
      throw error;
    }
  }
}

module.exports = SupervisionPlanImportController;
