'use strict';

const Controller = require('egg').Controller;
const { requireGlobalRead, requireGlobalWrite } = require('../lib/authorization');

class SupervisionDefinitionController extends Controller {
  async index() {
    requireGlobalRead(this.ctx);
    await this.ctx.render('supervision-definitions/index', {
      title: '检查方案',
      ...await this.ctx.service.supervisionDefinition.list(this.ctx.query),
      csrf: this.ctx.csrf,
    });
  }

  async centerObjects() {
    requireGlobalRead(this.ctx);
    await this.ctx.render('supervision-center-objects/index', {
      title: '中心检查对象',
      ...await this.ctx.service.supervisionDefinition.listCenterObjects(this.ctx.query),
      csrf: this.ctx.csrf,
      user: this.ctx.state.user,
    });
  }

  async create() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.supervisionDefinition.create(this.ctx.request.body || {}, this.ctx.session.userId);
    this.ctx.redirect('/supervision-definitions?notice=' + encodeURIComponent('监督定义已创建'));
  }

  async update() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.supervisionDefinition.update(this.ctx.params.definitionId, this.ctx.request.body || {}, this.ctx.session.userId);
    this.ctx.redirect('/supervision-definitions?notice=' + encodeURIComponent('监督定义已更新'));
  }
}

module.exports = SupervisionDefinitionController;
