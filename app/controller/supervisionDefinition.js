'use strict';

const Controller = require('egg').Controller;
const { requireGlobalRead, requireGlobalWrite } = require('../lib/authorization');
const { friendlyAiError } = require('../lib/aiProvider');

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

  async centerObjectDedupe() {
    requireGlobalRead(this.ctx);
    await this.ctx.render('supervision-center-objects/dedupe', {
      title: '中心检查对象去重',
      ...await this.ctx.service.supervisionDefinition.listCenterObjectDedupe(),
      csrf: this.ctx.csrf,
      user: this.ctx.state.user,
    });
  }

  async aiReviewCenterObject() {
    requireGlobalWrite(this.ctx);
    const payload = this.ctx.request.body || {};
    try {
      this.ctx.body = {
        data: await this.ctx.service.supervisionDefinition.aiReviewCenterObjectCandidate({
          centerName: payload.centerName,
          leftObjectName: payload.leftObjectName,
          rightObjectName: payload.rightObjectName,
        }),
      };
    } catch (error) {
      if (error.status || error.statusCode) throw error;
      const friendly = friendlyAiError(error, error.baseUrl);
      this.ctx.status = friendly.statusCode;
      this.ctx.body = { error: friendly.code, message: friendly.message };
      this.ctx.logger.warn('Center object AI review failed: %s (%s)', friendly.code, error.message);
    }
  }

  async reviewCenterObject() {
    requireGlobalWrite(this.ctx);
    this.ctx.body = {
      data: await this.ctx.service.supervisionDefinition.reviewCenterObjectCandidate(
        this.ctx.request.body || {},
        this.ctx.session.userId
      ),
    };
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
