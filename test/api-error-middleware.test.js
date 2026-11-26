'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const apiError = require('../app/middleware/api_error');

function context(path) {
  return {
    path,
    status: 404,
    type: '',
    body: null,
  };
}

test('returns readable JSON for API conflicts', async () => {
  const ctx = context('/api/supervision-center-objects/objects/source/split-drafts');
  const middleware = apiError();
  await middleware(ctx, async () => {
    const error = new Error('拆分目标名称已对应现有规范对象：运维堡垒机');
    error.status = 409;
    throw error;
  });
  assert.equal(ctx.status, 409);
  assert.equal(ctx.type, 'application/json');
  assert.deepEqual(ctx.body, { message: '拆分目标名称已对应现有规范对象：运维堡垒机' });
});

test('hides internal errors and leaves page routes unchanged', async () => {
  const apiContext = context('/api/example');
  const middleware = apiError();
  await middleware(apiContext, async () => {
    throw new Error('database password leaked');
  });
  assert.equal(apiContext.status, 500);
  assert.deepEqual(apiContext.body, { message: '服务器处理失败，请稍后重试' });

  const pageContext = context('/supervision-center-objects');
  const pageError = new Error('page error');
  await assert.rejects(middleware(pageContext, async () => { throw pageError; }), error => error === pageError);
});
