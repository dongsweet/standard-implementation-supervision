'use strict';

const Controller = require('egg').Controller;
const { requireSystemAdmin } = require('../lib/authorization');

class SystemSettingController extends Controller {
  async index() {
    requireSystemAdmin(this.ctx);
    await this.ctx.render('settings/index', {
      title: '系统配置',
      ai: await this.ctx.service.systemSetting.getPublicAiSettings(),
      csrf: this.ctx.csrf,
    });
  }

  async saveAi() {
    requireSystemAdmin(this.ctx);
    await this.ctx.service.systemSetting.saveAiSettings(this.ctx.request.body || {}, this.ctx.session.userId);
    this.ctx.redirect('/settings?notice=' + encodeURIComponent('AI服务配置已保存'));
  }

  async testAi() {
    requireSystemAdmin(this.ctx);
    const result = await this.ctx.service.systemSetting.testAiConnection(this.ctx.request.body || {});
    this.ctx.body = { data: result };
  }
}

module.exports = SystemSettingController;
