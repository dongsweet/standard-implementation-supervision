'use strict';

const Controller = require('egg').Controller;
const { requireGlobalRead, requireGlobalWrite } = require('../lib/authorization');

class DedupeController extends Controller {
  async index() {
    requireGlobalRead(this.ctx);
    const candidates = await this.ctx.service.dedupe.listCandidates({ limit: 50 });
    await this.ctx.render('dedupe/index', { title: '监督定义去重复核', candidates, csrf: this.ctx.csrf, user: this.ctx.state.user, message: null });
  }

  async candidates() {
    requireGlobalRead(this.ctx);
    const requestedLimit = Number.parseInt(this.ctx.query.limit, 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 50;
    this.ctx.body = { data: await this.ctx.service.dedupe.listCandidates({ limit }) };
  }

  async aiReview() {
    requireGlobalWrite(this.ctx);
    const { leftId, rightId } = this.ctx.request.body || {};
    if (!leftId || !rightId) this.ctx.throw(400, 'leftId 和 rightId 为必填项');
    this.ctx.body = { data: await this.ctx.service.dedupe.aiReview({ leftId, rightId }) };
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
