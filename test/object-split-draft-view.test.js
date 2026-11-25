'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let ejs;
try {
  ejs = require('ejs');
} catch {
  ejs = null;
}

test('shows saved split drafts with an explicit submission entry', () => {
  const view = fs.readFileSync(path.join(__dirname, '../app/view/supervision-center-objects/split-drafts.ejs'), 'utf8');
  assert.match(view, /对象拆分草案/);
  assert.match(view, /草案保存后不会修改业务数据/);
  assert.match(view, /核对并提交/);
  assert.match(view, /split-drafts\/<%= draft\.id %>/);
});

test('renders a draft submission page only after explicit confirmation', { skip: !ejs }, async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../app/view/supervision-center-objects/split-draft.ejs'), {
    draft: {
      id: 'draft-1',
      status: 'draft',
      source_object_name: '零信任',
      source_category: '',
      groups: [
        { name: '运维零信任', category: '运维管理区', planIds: [ 'p1', 'p2' ] },
        { name: '业务零信任', category: '业务平台', planIds: [ 'p3' ] },
      ],
    },
    preview: {
      plans: [
        { id: 'p1', plan_number: 62, description: '方案一', centers: [ '云中心' ] },
        { id: 'p2', plan_number: 234, description: '方案二', centers: [ '云中心' ] },
        { id: 'p3', plan_number: 37, description: '方案三', centers: [ '云中心' ] },
      ],
    },
    canWrite: true,
    csrf: 'test-token',
  });
  assert.match(html, /核对拆分草案/);
  assert.match(html, /运维零信任/);
  assert.match(html, /业务零信任/);
  assert.match(html, /id="splitSubmitConfirmation"/);
  assert.match(html, /最终提交拆分/);
  assert.match(html, /提交后才会真正拆分对象/);
});
