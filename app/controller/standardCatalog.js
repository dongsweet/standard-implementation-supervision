'use strict';

const Controller = require('egg').Controller;
const { requireGlobalRead, requireGlobalWrite } = require('../lib/authorization');

class StandardCatalogController extends Controller {
  async index() {
    requireGlobalRead(this.ctx);
    await this.ctx.render('standards/index', {
      title: '规范目录与版本',
      standards: await this.ctx.service.standardCatalog.listCatalog(),
      csrf: this.ctx.csrf,
    });
  }

  async createStandard() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.standardCatalog.createStandard(this.ctx.request.body || {});
    this.ctx.redirect('/standards');
  }

  async createVersion() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.standardCatalog.createVersion(this.ctx.params.standardId, this.ctx.request.body || {});
    this.ctx.redirect('/standards');
  }

  async version() {
    requireGlobalRead(this.ctx);
    const detail = await this.ctx.service.standardCatalog.getVersionDetail(this.ctx.params.versionId);
    await this.ctx.render('standards/version', { title: `${detail.version.standard_code} ${detail.version.version}`, ...detail, csrf: this.ctx.csrf });
  }

  async publishVersion() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.standardCatalog.publishVersion(this.ctx.params.versionId);
    this.ctx.redirect(`/standards/versions/${this.ctx.params.versionId}`);
  }

  async createChapter() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.standardCatalog.createChapter(this.ctx.params.versionId, this.ctx.request.body || {});
    this.ctx.redirect(`/standards/versions/${this.ctx.params.versionId}`);
  }

  async createItem() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.standardCatalog.createItem(this.ctx.params.chapterId, this.ctx.request.body || {});
    this.ctx.redirect(this.ctx.request.body.returnTo || '/standards');
  }

  async importItems() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.standardCatalog.importItems(this.ctx.params.chapterId, this.ctx.request.body.text);
    this.ctx.redirect(this.ctx.request.body.returnTo || '/standards');
  }
}

module.exports = StandardCatalogController;
