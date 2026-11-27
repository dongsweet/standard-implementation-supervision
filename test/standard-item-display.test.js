'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Repository = require('../app/repository/supervisionDefinition');

const viewRoot = path.join(__dirname, '../app/view');

test('loads standardized plan numbers with original-number and content details', async () => {
  let captured;
  const repository = new Repository({
    async query(sql) {
      captured = sql.replace(/\s+/g, ' ').trim();
      return { rows: [], rowCount: 0 };
    },
  });
  await repository.listCandidates({ threshold: 0.6, limit: 1000 });
  assert.match(captured, /'standardNumber', si\.standard_number, 'itemCode', si\.item_code/);
  assert.match(captured, /'content', left\(si\.content, 1000\)/);
  assert.match(captured, /AS standard_item_details/);
  assert.match(captured, /AS candidate_standard_item_details/);
});

test('uses the same standardized-number rule and hover text in plans and dedupe', () => {
  const planView = fs.readFileSync(path.join(viewRoot, 'supervision-definitions/index.ejs'), 'utf8');
  const dedupeView = fs.readFileSync(path.join(viewRoot, 'dedupe/index.ejs'), 'utf8');

  assert.match(planView, /const standardItemLabel = item => item\?\.standardNumber \|\| item\?\.code \|\| item\?\.itemCode \|\| '未编号'/);
  assert.match(planView, /原文编号：\$\{item\?\.code \|\| item\?\.itemCode \|\| '-'\}/);
  assert.match(planView, /标准项内容：\$\{item\?\.content \|\| item\?\.title \|\| '无标准项内容'\}/);
  assert.match(planView, /class="badge text-bg-light border definition-standard-item-badge" title="<%= standardItemTooltip\(item\) %>"/);

  assert.match(dedupeView, /const dedupeStandardItemLabel = item => item\?\.standardNumber \|\| item\?\.itemCode \|\| item\?\.code \|\| '未编号'/);
  assert.match(dedupeView, /const dedupeStandardItemTitle = item =>/);
  assert.match(dedupeView, /renderStandardItemBadges\(item\.standard_item_details/);
  assert.match(dedupeView, /renderStandardItemBadges\(item\.candidate_standard_item_details/);
  assert.match(dedupeView, /title="\$\{escapeDiffHtml\(dedupeStandardItemTitle\(item\)\)\}"/);
});
