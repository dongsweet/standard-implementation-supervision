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

  async centerObjectDedupeHistory() {
    requireGlobalRead(this.ctx);
    await this.ctx.render('supervision-center-objects/dedupe-history', {
      title: '中心检查对象去重复核历史',
      reviews: await this.ctx.service.supervisionDefinition.listCenterObjectReviews(),
      csrf: this.ctx.csrf,
      user: this.ctx.state.user,
    });
  }

  async centerObjectDedupe() {
    requireGlobalRead(this.ctx);
    const rawThreshold = this.ctx.query.threshold;
    const threshold = rawThreshold === undefined || rawThreshold === ''
      ? null
      : Number(rawThreshold);
    const scanned = this.ctx.query.run === '1' && Number.isFinite(threshold)
      && threshold >= 0 && threshold <= 1;
    const requestedFilter = String(this.ctx.query.filter || 'all');
    const filter = scanned && [ 'all', 'ai_duplicate', 'ai_excluded', 'ai_pending' ].includes(requestedFilter)
      ? requestedFilter
      : 'all';
    await this.ctx.render('supervision-center-objects/dedupe', {
      title: '中心检查对象去重',
      ...await this.ctx.service.supervisionDefinition.listCenterObjectDedupe({
        threshold: scanned ? threshold : null,
        scanned,
        filter,
      }),
      queryThreshold: threshold === null || !Number.isFinite(threshold)
        ? 0.6
        : threshold,
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

  async aiScreenCenterObjects() {
    requireGlobalWrite(this.ctx);
    const threshold = Number(this.ctx.request.body?.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      this.ctx.throw(400, '名称相似度门限必须在 0 到 1 之间');
    }
    this.ctx.body = {
      data: await this.ctx.service.supervisionDefinition.aiScreenCenterObjectCandidates({
        limit: this.ctx.request.body?.batchSize || this.ctx.request.body?.limit || 4,
        threshold,
      }),
    };
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

  async updateCenterObject() {
    requireGlobalWrite(this.ctx);
    this.ctx.body = {
      data: await this.ctx.service.supervisionDefinition.updateCenterObject(
        this.ctx.params.objectId, this.ctx.request.body || {}, this.ctx.session.userId
      ),
    };
  }

  async createCenterObjectCategory() {
    requireGlobalWrite(this.ctx);
    this.ctx.body = {
      data: await this.ctx.service.supervisionDefinition.createCenterObjectCategory(
        this.ctx.request.body || {}, this.ctx.session.userId
      ),
    };
  }

  async deleteCenterObjectCategory() {
    requireGlobalWrite(this.ctx);
    this.ctx.body = {
      data: await this.ctx.service.supervisionDefinition.deleteCenterObjectCategory(
        this.ctx.params.categoryId, this.ctx.session.userId
      ),
    };
  }

  async standardItemOptions() {
    requireGlobalRead(this.ctx);
    this.ctx.body = {
      data: await this.ctx.service.supervisionDefinition.searchStandardItemOptions(this.ctx.query.q),
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
    this.ctx.redirect('/supervision-definitions');
  }
}

module.exports = SupervisionDefinitionController;
