'use strict';

const Service = require('egg').Service;
const crypto = require('node:crypto');
const { friendlyAiError } = require('../lib/aiProvider');
const { coverageIssue, definitionIssues, issueContextHash, objectCategoryIssue } = require('../lib/jointReviewRules');
const { buildSemanticPairs } = require('../lib/semanticDuplicates');
const Repository = require('../repository/jointReview');

const REVIEW_TYPES = new Set([
  'object_content', 'plan_standard', 'frequency_answer', 'coverage', 'category_consistency',
  'semantic_duplicate',
]);
const HUMAN_DECISIONS = new Set([
  'no_issue', 'mismatch_confirmed', 'corrected', 'insufficient_information',
  'confirmed_same_check', 'confirmed_distinct_check',
]);

function compactDefinition(definition) {
  return {
    id: definition.id,
    planNumber: definition.plan_number,
    objectName: definition.object_name,
    objectCategory: definition.object_category,
    masterObjectName: definition.master_object_name,
    masterCategory: definition.master_category,
    checkLayer: definition.check_layer,
    checkMethod: definition.check_method,
    description: definition.description,
    steps: definition.steps,
    frequency: definition.frequency,
    accessMode: definition.access_mode,
    centers: definition.centers || [],
  };
}

function compactStandards(standards) {
  return (standards || []).map(item => ({
    id: item.id,
    standardNumber: item.standardNumber,
    code: item.code,
    title: item.title,
    content: String(item.content || '').slice(0, 3000),
    explanation: item.explanation,
  }));
}

class JointReviewService extends Service {
  get repository() {
    return new Repository(this.ctx.app.db);
  }

  normalizeScope(query = {}) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const scope = {};
    for (const field of [ 'definitionId', 'objectId', 'standardItemId', 'projectId', 'chapterId' ]) {
      const value = String(query[field] || '').trim();
      if (value && uuid.test(value)) scope[field] = value;
    }
    return scope;
  }

  async scan(query = {}) {
    const scope = this.normalizeScope(query);
    const [ definitions, scopedObjects, allObjects, coverage ] = await Promise.all([
      this.repository.listDefinitionContexts(scope),
      this.repository.listObjectContexts(scope),
      this.repository.listObjectContexts({}),
      this.repository.listCoverageContexts(scope),
    ]);
    const objectIds = new Set(scopedObjects.map(object => object.id));
    if (!scope.objectId) {
      for (const definition of definitions) {
        if (definition.object_id) objectIds.add(definition.object_id);
      }
    }
    const objects = allObjects.filter(object => objectIds.has(object.id));
    const candidates = [];
    const push = (issue, context, refs) => {
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([
        issue.reviewType,
        refs.definitionId || '',
        refs.objectId || '',
        refs.standardItemId || '',
        refs.projectId || '',
      ])).digest('hex');
      candidates.push({
        ...issue,
        fingerprint,
        contextHash: issueContextHash(issue, context),
        context,
        ...refs,
      });
    };

    for (const definition of definitions) {
      for (const issue of definitionIssues(definition)) {
        const context = {
          issueType: issue.reviewType,
          ruleReason: issue.ruleReason,
          definition: compactDefinition(definition),
          standardItems: compactStandards(definition.standard_items),
          projectAnswers: (definition.project_answers || []).slice(0, 5).map(answer => ({
            projectName: answer.projectName,
            status: answer.status,
            applicability: answer.applicability,
            clauseAssignment: answer.clauseAssignment,
            assignmentDetails: answer.assignmentDetails,
            complianceDescription: answer.complianceDescription,
            actualEvidence: answer.actualEvidence,
          })),
        };
        push(issue, context, {
          definitionId: definition.id,
          objectId: definition.object_id || null,
          standardItemId: issue.reviewType === 'plan_standard' && definition.standard_items?.length === 1
            ? definition.standard_items[0].id
            : null,
        });
      }
    }
    for (const object of objects) {
      const issue = objectCategoryIssue(object);
      if (!issue) continue;
      push(issue, {
        issueType: issue.reviewType,
        ruleReason: issue.ruleReason,
        object: {
          id: object.id,
          canonicalName: object.canonical_name,
          masterCategory: object.master_category,
          planCategories: object.plan_categories,
          planCount: object.plan_count,
        },
      }, { objectId: object.id });
    }
    for (const item of coverage) {
      const issue = coverageIssue(item);
      if (!issue) continue;
      push(issue, {
        issueType: issue.reviewType,
        ruleReason: issue.ruleReason,
        project: { id: item.project_id, name: item.project_name },
        standardItem: {
          id: item.standard_item_id,
          code: item.item_code,
          standardNumber: item.standard_number,
          title: item.title,
          content: String(item.content || '').slice(0, 3000),
        },
        projectAnswer: {
          status: item.status,
          applicability: item.applicability,
          clauseAssignment: item.clause_assignment,
          assignmentDetails: item.assignment_details,
          complianceDescription: item.compliance_description,
          actualEvidence: item.actual_evidence,
        },
        linkedPlanCount: Number(item.linked_plan_count),
      }, {
        objectId: null,
        projectId: item.project_id,
        standardItemId: item.standard_item_id,
      });
    }

    const saved = await this.repository.upsertCandidates(candidates);
    return { scope, candidateCount: candidates.length, ...saved };
  }

  async scanSemantic(query = {}, actorId = null) {
    const scope = this.normalizeScope(query);
    if (!scope.projectId) this.ctx.throw(400, '语义判同必须限定到项目');
    const plans = await this.repository.listSemanticContexts({ projectId: scope.projectId });
    const pairs = buildSemanticPairs(plans, { minimumScore: 0.35, limit: 80 });
    if (!pairs.length) return { projectId: scope.projectId, chapterId: '', candidateCount: 0, inserted: 0, updated: 0, failed: 0 };
    const aiConfig = await this.ctx.service.systemSetting.getAiConfig({ includeKey: false });
    const items = pairs.map((pair, index) => ({ id: `semantic-${index}-${pair.fingerprintSeed}`, ...pair }));
    const resultsById = new Map();
    for (let offset = 0; offset < items.length; offset += 8) {
      const batch = items.slice(offset, offset + 8);
      try {
        const response = await this.ctx.service.aiProvider.classifySemanticInspectionPairs(batch);
        for (const result of response.results) resultsById.set(result.id, result);
      } catch (error) {
        for (const item of batch) {
          resultsById.set(item.id, {
            id: item.id,
            semanticRelation: 'uncertain',
            confidence: 0,
            samePoints: [],
            differences: [],
            reason: friendlyAiError(error, error.baseUrl),
            recommendedKeepId: null,
            failed: true,
          });
        }
      }
    }
    const candidates = items.map(item => {
      const result = resultsById.get(item.id) || {
        semanticRelation: 'uncertain',
        confidence: 0,
        samePoints: [],
        differences: [],
        reason: '模型未返回该候选的判断',
        recommendedKeepId: null,
        failed: true,
      };
      if (result.recommendedKeepId) {
        result.recommendedKeepSide = result.recommendedKeepId === item.left.id ? 'A' : 'B';
      }
      const sameCheck = result.semanticRelation === 'same_check';
      const reviewType = 'semantic_duplicate';
      const relationLabel = {
        same_check: '可能为同一检查项',
        related_but_distinct: '相关但检查要求不同',
        unrelated: '语义上无关',
        uncertain: '需要人工进一步确认',
      }[result.semanticRelation] || '需要人工确认';
      const title = `语义判同：${item.left.objectName} ↔ ${item.right.objectName}`;
      const summary = `${relationLabel}。${result.reason || '请人工核对。'}`;
      const aiResult = {
        ...result,
        relationLabel,
        left: item.left,
        right: item.right,
        recallReasons: item.recallReasons,
      };
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([
        reviewType, scope.projectId,
        ...[ item.left.id, item.right.id ].sort(),
      ])).digest('hex');
      const context = {
        issueType: reviewType,
        projectId: scope.projectId,
        chapterId: item.chapterId,
        chapterIds: item.chapterIds,
        chapters: item.chapters,
        chapterCode: item.chapters?.[0]?.code || '',
        chapterName: item.chapters?.[0]?.name || '',
        recallReasons: item.recallReasons,
        left: item.left,
        right: item.right,
        ai: result,
      };
      return {
        reviewType,
        severity: sameCheck && Number(result.confidence) >= 0.75 ? 'warning' : 'info',
        fingerprint,
        contextHash: crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex'),
        projectId: scope.projectId,
        chapterId: item.chapterId || null,
        chapterIds: item.chapterIds || [],
        definitionId: item.left.id,
        objectId: item.left.objectId || null,
        standardItemId: item.sharedStandardIds[0] || item.left.standardItems[0]?.id || null,
        title,
        summary,
        ruleReason: item.recallReasons.join('；'),
        context,
        aiStatus: result.failed ? 'failed' : 'completed',
        aiResult,
        aiModel: aiConfig.model || null,
        promptVersion: 'semantic-inspection-v1',
        aiInputHash: crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex'),
        aiError: result.failed ? result.reason : null,
      };
    });
    const saved = await this.repository.upsertSemanticCandidates(candidates);
    await this.ctx.app.db.query(`
      INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, 'scan_semantic_joint_review', 'project', $2, $3)`, [
      actorId || null,
      scope.projectId,
      JSON.stringify({
        projectId: scope.projectId,
        scope: 'project',
        candidateCount: candidates.length,
        inserted: saved.inserted,
        updated: saved.updated,
        failed: saved.failed,
        model: aiConfig.model || null,
        promptVersion: 'semantic-inspection-v1',
      }),
    ]);
    return {
      projectId: scope.projectId,
      chapterId: '',
      candidateCount: candidates.length,
      ...saved,
    };
  }

  async list(query = {}) {
    const scope = this.normalizeScope(query);
    const reviewType = REVIEW_TYPES.has(String(query.reviewType || '')) ? String(query.reviewType) : '';
    const humanDecision = [ 'pending', ...HUMAN_DECISIONS ].includes(String(query.humanDecision || ''))
      ? String(query.humanDecision)
      : '';
    const reviews = await this.repository.listReviews({ ...scope, reviewType, humanDecision });
    return {
      definitionId: scope.definitionId || '',
      objectId: scope.objectId || '',
      standardItemId: scope.standardItemId || '',
      projectId: scope.projectId || '',
      chapterId: scope.chapterId || '',
      reviewType,
      humanDecision,
      reviews,
      summary: {
        total: reviews.length,
        error: reviews.filter(item => item.severity === 'error').length,
        warning: reviews.filter(item => item.severity === 'warning').length,
        pending: reviews.filter(item => !item.human_decision).length,
        completed: reviews.filter(item => item.human_decision).length,
        aiCompleted: reviews.filter(item => item.ai_status === 'completed').length,
      },
    };
  }

  async aiReview(id) {
    const review = await this.repository.findById(id);
    if (!review) this.ctx.throw(404, '联合复核记录不存在');
    const inputHash = crypto.createHash('sha256').update(JSON.stringify(review.context)).digest('hex');
    if (review.ai_result && review.ai_input_hash === inputHash) return review;
    const aiConfig = await this.ctx.service.systemSetting.getAiConfig({ includeKey: false });
    try {
      const response = await this.ctx.service.aiProvider.reviewJointIssue({
        title: review.title,
        summary: review.summary,
        ruleReason: review.rule_reason,
        context: review.context,
      });
      return this.repository.saveAiResult(id, {
        result: response.result,
        model: aiConfig.model || null,
        promptVersion: 'joint-review-v1',
        inputHash,
      });
    } catch (error) {
      await this.repository.saveAiError(id, error);
      error.friendly = friendlyAiError(error, error.baseUrl);
      throw error;
    }
  }

  async saveHumanDecision(id, payload, reviewerId) {
    const review = await this.repository.findById(id);
    if (!review) this.ctx.throw(404, '联合复核记录不存在');
    const decision = String(payload.decision || '').trim();
    if (!HUMAN_DECISIONS.has(decision)) this.ctx.throw(400, '无效的人工复核结论');
    const notes = String(payload.notes || '').trim().slice(0, 2000);
    if (decision !== 'no_issue' && !notes) this.ctx.throw(400, '确认问题或标记已修正时请填写复核备注');
    return this.repository.saveHumanDecision(id, { decision, notes, reviewerId });
  }

  async reviewAccess(reviewId) {
    return this.repository.findById(reviewId);
  }

  async listUserResponsibleChapterIds({ projectId, userId }) {
    return this.repository.listUserResponsibleChapterIds({ projectId, userId });
  }

  async chapterReviewSummaries({ projectId, chapterIds }) {
    const rows = await this.repository.listChapterReviewSummaries({ projectId, chapterIds });
    return new Map(rows.map(row => [ String(row.chapter_id), row ]));
  }

  async isChapterResponsible(reviewId, userId) {
    const review = await this.repository.findById(reviewId);
    if (!review) return false;
    return this.repository.isChapterResponsible({
      projectId: review.project_id,
      chapterId: review.chapter_id,
      chapterIds: review.chapter_ids || [],
      userId,
    });
  }

  async canSaveHumanDecision(reviewId, userId) {
    const review = await this.repository.findById(reviewId);
    if (!review) return false;
    return this.repository.isChapterResponsible({
      projectId: review.project_id,
      chapterId: review.chapter_id,
      chapterIds: review.chapter_ids || [],
      userId,
    });
  }
}

module.exports = JointReviewService;
