'use strict';

const Controller = require('egg').Controller;
const { requireSystemAdmin } = require('../lib/authorization');
const { friendlyAiError } = require('../lib/aiProvider');

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
    const payload = this.ctx.request.body || {};
    try {
      const result = await this.ctx.service.systemSetting.testAiConnection(payload);
      this.ctx.body = { data: result };
    } catch (error) {
      if (error.status) throw error;
      const friendly = friendlyAiError(error, error.baseUrl || payload.baseUrl);
      this.ctx.status = friendly.statusCode;
      this.ctx.body = { error: friendly.code, message: friendly.message };
      this.ctx.logger.warn('AI connection test failed: %s (%s)', friendly.code, error.message);
    }
  }
}

module.exports = SystemSettingController;
