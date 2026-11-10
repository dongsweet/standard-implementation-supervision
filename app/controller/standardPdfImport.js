'use strict';

const Controller = require('egg').Controller;
const { requireGlobalRead, requireGlobalWrite } = require('../lib/authorization');

class StandardPdfImportController extends Controller {
  async create() {
    const versionId = this.ctx.params.versionId;
    try {
      requireGlobalWrite(this.ctx);
      const file = (this.ctx.request.files || []).find(item => item.fieldname === 'file');
      const job = await this.ctx.service.standardPdfImport.create(versionId, file, this.ctx.session.userId);
      this.ctx.runInBackground(async backgroundCtx => {
        await backgroundCtx.service.standardPdfImport.process(job.id, versionId);
      });
      this.ctx.redirect(`/standards/versions/${versionId}/pdf-imports/${job.id}`);
    } catch (error) {
      if ([ 400, 404, 409 ].includes(error.status)) {
        this.ctx.redirect(`/standards/versions/${versionId}?notice=` + encodeURIComponent('PDF导入失败：' + error.message));
        return;
      }
      throw error;
    } finally {
      await this.ctx.cleanupRequestFiles();
    }
  }

  async show() {
    requireGlobalRead(this.ctx);
    const versionId = this.ctx.params.versionId;
    const job = await this.ctx.service.standardPdfImport.find(versionId, this.ctx.params.jobId);
    await this.ctx.render('standards/pdf-import-review', {
      title: `PDF导入 · ${job.standard_code} · ${job.version}`,
      versionId,
      job,
      result: job.status === 'ready' ? job.result : null,
      csrf: this.ctx.csrf,
    });
  }

  async status() {
    requireGlobalRead(this.ctx);
    const job = await this.ctx.service.standardPdfImport.find(this.ctx.params.versionId, this.ctx.params.jobId);
    this.ctx.body = {
      id: job.id,
      status: job.status,
      progress: job.progress,
      pageCount: job.page_count,
      errorMessage: job.error_message,
    };
  }

  async aiReview() {
    requireGlobalWrite(this.ctx);
    const payload = { ...(this.ctx.request.body || {}) };
    if (typeof payload.nodes === 'string') {
      try {
        payload.nodes = JSON.parse(payload.nodes);
      } catch {
        this.ctx.throw(400, 'AI校验请求格式无效');
      }
    }
    this.ctx.body = {
      data: await this.ctx.service.standardPdfImport.aiReview(
        this.ctx.params.versionId,
        this.ctx.params.jobId,
        payload
      ),
    };
  }

  async apply() {
    requireGlobalWrite(this.ctx);
    const versionId = this.ctx.params.versionId;
    let nodes;
    try {
      nodes = JSON.parse(this.ctx.request.body.selection || '[]');
    } catch {
      this.ctx.throw(400, '导入选择格式无效');
    }
    const result = await this.ctx.service.standardPdfImport.apply(
      versionId,
      this.ctx.params.jobId,
      { nodes },
      this.ctx.session.userId
    );
    this.ctx.redirect(`/standards/versions/${versionId}?notice=` + encodeURIComponent(
      `PDF导入完成：${result.chapterCount}个章节，${result.itemCount}个标准项`
    ));
  }
}

module.exports = StandardPdfImportController;
