'use strict';

const Controller = require('egg').Controller;
const { requireGlobalRead, requireGlobalWrite } = require('../lib/authorization');

class SupervisionDefinitionController extends Controller {
  async index() {
    requireGlobalRead(this.ctx);
    await this.ctx.render('supervision-definitions/index', {
      title: '监督定义',
      ...await this.ctx.service.supervisionDefinition.list(),
      csrf: this.ctx.csrf,
    });
  }

  async create() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.supervisionDefinition.create(this.ctx.request.body || {});
    this.ctx.redirect('/supervision-definitions?notice=' + encodeURIComponent('监督定义已创建'));
  }

  async update() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.supervisionDefinition.update(this.ctx.params.definitionId, this.ctx.request.body || {});
    this.ctx.redirect('/supervision-definitions?notice=' + encodeURIComponent('监督定义已更新'));
  }
}

module.exports = SupervisionDefinitionController;
