'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
let Controller;
try {
  Controller = require('../app/controller/jointReview');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const projectId = '00000000-0000-0000-0000-000000000001';
const userId = '00000000-0000-0000-0000-000000000002';

test('allows chapter owners to decide only reviews from their chapters', { skip: !Controller }, async () => {
  const controller = Object.create(Controller.prototype);
  let rendered;
  controller.ctx = {
    query: { projectId, chapterId: 'chapter-1' },
    session: { userId },
    state: {
      roles: [ { code: 'operator', scope: 'project', projectId } ],
      user: { id: userId },
    },
    csrf: 'csrf-token',
    throw(status, message) {
      const error = new Error(message);
      error.status = status;
      throw error;
    },
    async render(template, locals) {
      rendered = { template, locals };
    },
    service: {
      jointReview: {
        async list() {
          return {
            projectId,
            chapterId: 'chapter-1',
            reviews: [
              { id: 'review-own', chapter_id: 'chapter-1', chapter_ids: [ 'chapter-1', 'chapter-2' ], review_type: 'semantic_duplicate', title: '自己的复核' },
              { id: 'review-other', chapter_id: 'chapter-2', chapter_ids: [ 'chapter-2', 'chapter-3' ], review_type: 'semantic_duplicate', title: '其他章节复核' },
            ],
            summary: { total: 2 },
          };
        },
        async listUserResponsibleChapterIds() {
          return [ 'chapter-1' ];
        },
      },
    },
  };
  await controller.index();
  assert.equal(rendered.template, 'joint-reviews/index');
  assert.equal(rendered.locals.reviews[0].can_review, true);
  assert.equal(rendered.locals.reviews[1].can_review, false);
  assert.equal(rendered.locals.canReview, true);
  assert.equal(rendered.locals.canSubmitSemantic, false);
});
