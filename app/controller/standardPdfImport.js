'use strict';

const Controller = require('egg').Controller;
const { requireGlobalRead, requireGlobalWrite } = require('../lib/authorization');

class StandardPdfImportController extends Controller {
  async create() {
    const versionId = this.ctx.params.versionId;
    try {
      requireGlobalWrite(this.ctx);
      const files = this.ctx.request.files || [];
      const file = files.find(item => item.fieldname === 'file');
      const comparisonFile = files.find(item => item.fieldname === 'comparisonFile');
      const job = await this.ctx.service.standardPdfImport.create(versionId, file, comparisonFile, this.ctx.session.userId);
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

  async smartReview() {
    requireGlobalWrite(this.ctx);
    const payload = { ...(this.ctx.request.body || {}) };
    if (typeof payload.nodeIds === 'string') {
      try {
        payload.nodeIds = JSON.parse(payload.nodeIds);
      } catch {
        this.ctx.throw(400, '智能复核请求格式无效');
      }
    }
    try {
      this.ctx.body = {
        data: await this.ctx.service.standardPdfImport.smartReview(
          this.ctx.params.versionId,
          this.ctx.params.jobId,
          payload
        ),
      };
    } catch (error) {
      if (error.status) throw error;
      throw error;
    }
  }

  async saveDraft() {
    requireGlobalWrite(this.ctx);
    const payload = { ...(this.ctx.request.body || {}) };
    if (typeof payload.nodes === 'string') {
      try {
        payload.nodes = JSON.parse(payload.nodes);
      } catch {
        this.ctx.throw(400, '草稿保存请求格式无效');
      }
    }
    try {
      const result = await this.ctx.service.standardPdfImport.saveDraft(
        this.ctx.params.versionId,
        this.ctx.params.jobId,
        payload,
        this.ctx.session.userId
      );
      this.ctx.body = { data: { updatedAt: result.updated_at, message: '草稿已保存' } };
    } catch (error) {
      if (error.status) throw error;
      throw error;
    }
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

  async remove() {
    const versionId = this.ctx.params.versionId;
    try {
      requireGlobalWrite(this.ctx);
      const result = await this.ctx.service.standardPdfImport.remove(
        versionId,
        this.ctx.params.jobId,
        this.ctx.session.userId
      );
      const suffix = result.cleanupFailures.length
        ? '任务记录已清理，但部分临时文件删除失败，请联系管理员查看日志'
        : result.status === 'completed'
          ? '任务及临时文件已清理，已写入规范库的内容已保留'
          : '任务及临时文件已清理';
      this.ctx.redirect(`/standards/versions/${versionId}?notice=` + encodeURIComponent(suffix));
    } catch (error) {
      if ([ 404, 409 ].includes(error.status)) {
        this.ctx.redirect(`/standards/versions/${versionId}?notice=` + encodeURIComponent('清理失败：' + error.message));
        return;
      }
      throw error;
    }
  }
}

module.exports = StandardPdfImportController;
