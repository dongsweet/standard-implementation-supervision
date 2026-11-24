'use strict';

const Controller = require('egg').Controller;
const { requireGlobalRead, requireGlobalWrite } = require('../lib/authorization');
const { friendlyAiError } = require('../lib/aiProvider');

class DedupeController extends Controller {
  async index() {
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
    await this.ctx.render('dedupe/index', {
      title: '检查方案去重复核',
      ...await this.ctx.service.dedupe.listDefinitionDedupe({
        threshold: scanned ? threshold : null,
        scanned,
        filter,
      }),
      queryThreshold: threshold === null || !Number.isFinite(threshold) ? 0.35 : threshold,
      csrf: this.ctx.csrf,
      user: this.ctx.state.user,
    });
  }

  async history() {
    requireGlobalRead(this.ctx);
    await this.ctx.render('dedupe/history', {
      title: '检查方案去重复核历史',
      reviews: await this.ctx.service.dedupe.listReviews(),
      csrf: this.ctx.csrf,
      user: this.ctx.state.user,
    });
  }

  async candidates() {
    requireGlobalRead(this.ctx);
    const requestedLimit = Number.parseInt(this.ctx.query.limit, 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 200;
    const threshold = Number(this.ctx.query.threshold || 0.35);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) this.ctx.throw(400, '门限必须在 0 到 1 之间');
    this.ctx.body = { data: await this.ctx.service.dedupe.listCandidates({ limit, threshold }) };
  }

  async aiReview() {
    requireGlobalWrite(this.ctx);
    const { leftId, rightId } = this.ctx.request.body || {};
    if (!leftId || !rightId) this.ctx.throw(400, 'leftId 和 rightId 为必填项');
    try {
      this.ctx.body = { data: await this.ctx.service.dedupe.aiReview({ leftId, rightId }) };
    } catch (error) {
      if (error.status || error.statusCode) throw error;
      const friendly = friendlyAiError(error, error.baseUrl);
      this.ctx.status = friendly.statusCode;
      this.ctx.body = { error: friendly.code, message: friendly.message };
    }
  }

  async aiScreen() {
    requireGlobalWrite(this.ctx);
    const threshold = Number(this.ctx.request.body?.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      this.ctx.throw(400, '检查方案相似度门限必须在 0 到 1 之间');
    }
    this.ctx.body = {
      data: await this.ctx.service.dedupe.aiScreenDefinitionCandidates({
        limit: this.ctx.request.body?.batchSize || this.ctx.request.body?.limit || 4,
        threshold,
      }),
    };
  }

  async review() {
    requireGlobalWrite(this.ctx);
    const payload = this.ctx.request.body || {};
    const allowed = new Set([ 'duplicate', 'similar_but_distinct', 'unrelated', 'uncertain' ]);
    if (!payload.leftId || !payload.rightId || !allowed.has(payload.decision)) {
      this.ctx.throw(400, 'leftId、rightId 和有效 decision 为必填项');
    }
    const result = await this.ctx.service.dedupe.review({
      ...payload,
      reviewerId: this.ctx.session.userId || null,
      confirmConflicts: payload.confirmConflicts === true || payload.confirmConflicts === 'true',
    });
    this.ctx.body = { data: result };
  }
}

module.exports = DedupeController;
