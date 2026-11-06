'use strict';

const Controller = require('egg').Controller;
const { requireGlobalRead, requireGlobalWrite } = require('../lib/authorization');

class CloudCenterController extends Controller {
  async index() {
    requireGlobalRead(this.ctx);
    await this.ctx.render('cloud-centers/index', {
      title: '云中心管理',
      cloudCenters: await this.ctx.service.cloudCenter.listAll(),
      csrf: this.ctx.csrf,
    });
  }

  async create() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.cloudCenter.create(this.ctx.request.body || {});
    this.ctx.redirect('/cloud-centers?notice=' + encodeURIComponent('云中心已创建'));
  }

  async update() {
    requireGlobalWrite(this.ctx);
    await this.ctx.service.cloudCenter.update(this.ctx.params.cloudCenterId, this.ctx.request.body || {});
    this.ctx.redirect('/cloud-centers?notice=' + encodeURIComponent('云中心已更新'));
  }
}

module.exports = CloudCenterController;
