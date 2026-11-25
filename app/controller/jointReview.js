'use strict';

const Controller = require('egg').Controller;
const { requireGlobalRead, requireGlobalWrite } = require('../lib/authorization');

class JointReviewController extends Controller {
  async index() {
    requireGlobalRead(this.ctx);
    await this.ctx.render('joint-reviews/index', {
      title: '联合复核',
      ...await this.ctx.service.jointReview.list(this.ctx.query),
      csrf: this.ctx.csrf,
    });
  }

  async scan() {
    requireGlobalWrite(this.ctx);
    const result = await this.ctx.service.jointReview.scan(this.ctx.request.body || {});
    const query = new URLSearchParams();
    for (const field of [ 'definitionId', 'objectId', 'standardItemId', 'projectId' ]) {
      const value = String((this.ctx.request.body || {})[field] || '').trim();
      if (value) query.set(field, value);
    }
    query.set('notice', `已生成 ${result.candidateCount} 条联合复核候选`);
    this.ctx.redirect('/joint-reviews?' + query.toString());
  }

  async aiReview() {
    requireGlobalWrite(this.ctx);
    try {
      this.ctx.body = { data: await this.ctx.service.jointReview.aiReview(this.ctx.params.reviewId) };
    } catch (error) {
      if (error.status || error.statusCode) throw error;
      const friendly = error.friendly || { statusCode: 502, message: error.message };
      this.ctx.status = friendly.statusCode;
      this.ctx.body = { message: friendly.message };
    }
  }

  async saveHumanDecision() {
    requireGlobalWrite(this.ctx);
    this.ctx.body = {
      data: await this.ctx.service.jointReview.saveHumanDecision(
        this.ctx.params.reviewId,
        this.ctx.request.body || {},
        this.ctx.session.userId
      ),
    };
  }
}

module.exports = JointReviewController;
