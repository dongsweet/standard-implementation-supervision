'use strict';

const Controller = require('egg').Controller;
const {
  canReadProject,
  canWriteProject,
  requireGlobalRead,
  requireGlobalWrite,
  requireProject,
} = require('../lib/authorization');

class JointReviewController extends Controller {
  globalWriteAllowed() {
    return (this.ctx.state.roles || []).some(role =>
      !role.projectId && [ 'system_admin', 'security_admin' ].includes(role.code)
    );
  }

  async index() {
    const projectId = String(this.ctx.query.projectId || '').trim();
    if (projectId) requireProject(this.ctx, projectId);
    else requireGlobalRead(this.ctx);
    await this.ctx.render('joint-reviews/index', {
      title: '联合复核',
      ...await this.ctx.service.jointReview.list(this.ctx.query),
      canReview: this.globalWriteAllowed() || (projectId && canWriteProject(this.ctx.state.roles || [], projectId)),
      canSubmitSemantic: this.globalWriteAllowed() || (projectId && canWriteProject(this.ctx.state.roles || [], projectId)),
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

  async semanticScan() {
    const payload = this.ctx.request.body || {};
    const projectId = String(payload.projectId || '').trim();
    if (!projectId) this.ctx.throw(400, '语义判同必须限定到项目');
    if (!this.globalWriteAllowed() && !canWriteProject(this.ctx.state.roles || [], projectId)) {
      this.ctx.throw(403, '无权发起项目语义判同');
    }
    const result = await this.ctx.service.jointReview.scanSemantic(payload);
    const query = new URLSearchParams({ projectId });
    if (payload.chapterId) query.set('chapterId', String(payload.chapterId));
    query.set('reviewType', 'semantic_duplicate');
    query.set('humanDecision', 'pending');
    query.set('notice', `语义判同完成：生成 ${result.candidateCount} 组候选，模型失败 ${result.failed || 0} 组`);
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
    const review = await this.ctx.service.jointReview.reviewAccess(this.ctx.params.reviewId);
    if (!review) this.ctx.throw(404, '联合复核记录不存在');
    const roles = this.ctx.state.roles || [];
    const allowed = this.globalWriteAllowed()
      || (review.project_id && canWriteProject(roles, review.project_id))
      || (review.project_id && canReadProject(roles, review.project_id)
        && await this.ctx.service.jointReview.isChapterResponsible(
          this.ctx.params.reviewId,
          this.ctx.session.userId
        ));
    if (!allowed) this.ctx.throw(403, '仅项目管理员或对应章节负责人可确认复核结论');
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
