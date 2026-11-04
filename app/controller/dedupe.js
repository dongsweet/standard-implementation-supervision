'use strict';

const Controller = require('egg').Controller;

class DedupeController extends Controller {
  async index() {
    const candidates = await this.ctx.service.dedupe.listCandidates({ limit: 50 });
    await this.ctx.render('dedupe/index', { title: '监督定义去重复核', candidates, csrf: this.ctx.csrf });
  }

  async candidates() {
    const limit = Math.min(Number(this.ctx.query.limit || 50), 200);
    this.ctx.body = { data: await this.ctx.service.dedupe.listCandidates({ limit }) };
  }

  async aiReview() {
    const { leftId, rightId } = this.ctx.request.body || {};
    if (!leftId || !rightId) this.ctx.throw(400, 'leftId 和 rightId 为必填项');
    this.ctx.body = { data: await this.ctx.service.dedupe.aiReview({ leftId, rightId }) };
  }

  async review() {
    const payload = this.ctx.request.body || {};
    const allowed = new Set([ 'duplicate', 'similar_but_distinct', 'unrelated', 'uncertain' ]);
    if (!payload.leftId || !payload.rightId || !allowed.has(payload.decision)) {
      this.ctx.throw(400, 'leftId、rightId 和有效 decision 为必填项');
    }
    const result = await this.ctx.service.dedupe.review({
      ...payload,
      reviewerId: this.ctx.session.userId || null,
    });
    this.ctx.body = { data: result };
  }
}

module.exports = DedupeController;
