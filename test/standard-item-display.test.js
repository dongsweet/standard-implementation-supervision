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

test('shows standardized-number badges with an immediate global detail tooltip', () => {
  const layout = fs.readFileSync(path.join(viewRoot, 'layout.ejs'), 'utf8');
  const planView = fs.readFileSync(path.join(viewRoot, 'supervision-definitions/index.ejs'), 'utf8');
  const dedupeView = fs.readFileSync(path.join(viewRoot, 'dedupe/index.ejs'), 'utf8');

  assert.match(layout, /id="standardItemDetailTooltip"/);
  assert.match(layout, /id="standardItemTooltipOriginal"/);
  assert.match(layout, /id="standardItemTooltipContent"/);
  assert.match(layout, /document\.addEventListener\('mouseover'/);
  assert.match(layout, /document\.addEventListener\('focusin'/);
  assert.match(layout, /target\.dataset\.originalNumber/);
  assert.match(layout, /target\.dataset\.standardContent/);
  assert.match(layout, /#standardItemDetailTooltip\.show \{ visibility:visible; opacity:1; \}/);

  assert.match(planView, /const standardItemLabel = item => item\?\.standardNumber \|\| item\?\.code \|\| item\?\.itemCode \|\| '未编号'/);
  assert.match(planView, /data-standard-item-detail data-standard-number="<%= standardItemLabel\(item\) %>"/);
  assert.match(planView, /data-original-number="<%= standardItemOriginalNumber\(item\) %>"/);
  assert.match(planView, /data-standard-content="<%= standardItemContent\(item\) %>"/);
  assert.match(planView, /function setPlanStandardItemDetail/);
  assert.match(planView, /element\.dataset\.standardContent/);
  assert.doesNotMatch(planView, /definition-standard-item-badge" title=/);

  assert.match(dedupeView, /const dedupeStandardItemLabel = item => item\?\.standardNumber \|\| item\?\.itemCode \|\| item\?\.code \|\| '未编号'/);
  assert.match(dedupeView, /renderStandardItemBadges\(item\.standard_item_details/);
  assert.match(dedupeView, /renderStandardItemBadges\(item\.candidate_standard_item_details/);
  assert.match(dedupeView, /data-standard-item-detail data-standard-number="\$\{escapeDiffHtml\(dedupeStandardItemLabel\(item\)\)\}"/);
  assert.match(dedupeView, /data-original-number="\$\{escapeDiffHtml\(dedupeStandardItemOriginal\(item\)\)\}"/);
  assert.match(dedupeView, /data-standard-content="\$\{escapeDiffHtml\(dedupeStandardItemContent\(item\)\)\}"/);
  assert.match(dedupeView, /function setMergeStandardItemDetail|const setMergeStandardItemDetail/);
  assert.doesNotMatch(dedupeView, /definition-standard-item-badge[^`]*title=/);
});
