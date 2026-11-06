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

  async createVersion() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.standardCatalog.createVersion(this.ctx.params.standardId, this.ctx.request.body || {});
    this.ctx.redirect('/standards?notice=' + encodeURIComponent('规范草稿版本已创建'));
  }

  async version() {
    requireGlobalRead(this.ctx);
    const detail = await this.ctx.service.standardCatalog.getVersionDetail(this.ctx.params.versionId);
    await this.ctx.render('standards/version', { title: `${detail.version.standard_code} · ${detail.version.version} 发布版`, ...detail, csrf: this.ctx.csrf });
  }

  async publishVersion() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.standardCatalog.publishVersion(this.ctx.params.versionId);
    this.ctx.redirect(`/standards/versions/${this.ctx.params.versionId}?notice=` + encodeURIComponent('规范发布版已发布'));
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
