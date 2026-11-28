'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const viewRoot = path.join(__dirname, '../app/view');

test('exposes semantic review controls and chapter-level pending prompts', () => {
  const joint = fs.readFileSync(path.join(viewRoot, 'joint-reviews/index.ejs'), 'utf8');
  const answers = fs.readFileSync(path.join(viewRoot, 'projects/answer-standard.ejs'), 'utf8');
  assert.match(joint, /semantic_duplicate: '检查项语义判同'/);
  assert.match(joint, /运行全项目语义判同/);
  assert.match(joint, /跨章节比较/);
  assert.match(joint, /canSubmitSemantic/);
  assert.match(joint, /EDR 与终端杀毒/);
  assert.match(joint, /same_check/);
  assert.match(joint, /confirmed_same_check/);
  assert.match(joint, /confirmed_distinct_check/);
  assert.match(joint, /if \(review\.can_review\)/);
  const service = fs.readFileSync(path.join(__dirname, '../app/service/jointReview.js'), 'utf8');
  assert.match(service, /scan_semantic_joint_review/);
  assert.match(service, /promptVersion: 'semantic-inspection-v1'/);
  assert.match(answers, /project\.project_id/);
  assert.match(answers, /chapter\.semantic_pending_count && chapter\.chapter_id/);
  assert.match(answers, /条语义判同待复核/);
  assert.match(answers, /全项目语义判同/);
  assert.match(answers, /扫描整个项目，不限制在当前章节/);
  assert.match(answers, /reviewType=semantic_duplicate/);
});
