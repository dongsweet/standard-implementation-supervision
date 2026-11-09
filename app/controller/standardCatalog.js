'use strict';

const Controller = require('egg').Controller;
const { requireGlobalRead, requireGlobalWrite } = require('../lib/authorization');
const { STANDARD_TYPES } = require('../lib/standardTypes');

class StandardCatalogController extends Controller {
  async index() {
    requireGlobalRead(this.ctx);
    const catalog = await this.ctx.service.standardCatalog.listCatalog(this.ctx.query);
    await this.ctx.render('standards/index', {
      title: '规范库',
      ...catalog,
      standardTypes: STANDARD_TYPES,
      csrf: this.ctx.csrf,
    });
  }

  async createStandard() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.standardCatalog.createStandard(this.ctx.request.body || {});
    this.ctx.redirect('/standards?notice=' + encodeURIComponent('规范已创建'));
  }

  async importStandard() {
    try {
      requireGlobalWrite(this.ctx);
      const file = (this.ctx.request.files || []).find(item => item.fieldname === 'file');
      if (!file) this.ctx.throw(400, '请选择要导入的Excel或TSV文件');
      const result = await this.ctx.service.standardCatalog.importStandard(this.ctx.request.body || {}, file.filepath, file.filename);
      const notice = result.standardCode + '导入完成：' + result.chapterCount + '个章节，' + result.itemCount + '个标准项';
      this.ctx.redirect('/standards?notice=' + encodeURIComponent(notice));
    } catch (error) {
      if ([ 400, 409 ].includes(error.status)) {
        const message = '导入失败：' + (error.message || '请检查文件后重试');
        this.ctx.redirect('/standards?notice=' + encodeURIComponent(message));
        return;
      }
      throw error;
    } finally {
      await this.ctx.cleanupRequestFiles();
    }
  }

  async updateStandard() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.standardCatalog.updateStandard(
      this.ctx.params.standardId,
      this.ctx.params.versionId,
      this.ctx.request.body || {}
    );
    this.ctx.redirect('/standards?notice=' + encodeURIComponent('规范信息已更新'));
  }

  async createVersion() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.standardCatalog.createVersion(this.ctx.params.standardId, this.ctx.request.body || {});
    this.ctx.redirect('/standards?notice=' + encodeURIComponent('规范版本已创建'));
  }

  async version() {
    requireGlobalRead(this.ctx);
    const detail = await this.ctx.service.standardCatalog.getVersionDetail(this.ctx.params.versionId);
    await this.ctx.render('standards/version', { title: `${detail.version.standard_code} · ${detail.version.version}`, ...detail, csrf: this.ctx.csrf });
  }

  async createChapter() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.standardCatalog.createChapter(this.ctx.params.versionId, this.ctx.request.body || {});
    this.ctx.redirect(`/standards/versions/${this.ctx.params.versionId}?notice=` + encodeURIComponent('章节已创建'));
  }

  async createItem() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.standardCatalog.createItem(this.ctx.params.chapterId, this.ctx.request.body || {});
    const returnTo = this.ctx.request.body.returnTo || '/standards';
    this.ctx.redirect(returnTo + (returnTo.includes('?') ? '&' : '?') + 'notice=' + encodeURIComponent('标准项已创建'));
  }

  async importItems() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.standardCatalog.importItems(this.ctx.params.chapterId, this.ctx.request.body.text);
    const returnTo = this.ctx.request.body.returnTo || '/standards';
    this.ctx.redirect(returnTo + (returnTo.includes('?') ? '&' : '?') + 'notice=' + encodeURIComponent('标准项导入完成'));
  }
}

module.exports = StandardCatalogController;
