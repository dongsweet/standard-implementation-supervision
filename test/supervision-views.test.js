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

const viewRoot = path.join(__dirname, '../app/view');

test('keeps the plan list project-neutral, compact, and filterable', () => {
  const planView = fs.readFileSync(path.join(viewRoot, 'supervision-definitions/index.ejs'), 'utf8');
  const executionView = fs.readFileSync(path.join(viewRoot, 'supervision-executions/index.ejs'), 'utf8');
  assert.match(planView, /检查方案是系统级可复用定义/);
  assert.match(planView, /name="search"/);
  assert.match(planView, /name="priority"/);
  assert.match(planView, /name="checkMethod"/);
  assert.match(planView, /name="scope"/);
  assert.match(planView, /name="centers"/);
  assert.match(planView, /适用检查中心/);
  assert.match(planView, /name="status"/);
  assert.match(planView, /buildPageUrl\(pageValue - 1\)/);
  assert.match(planView, /definitionDetailModal/);
  assert.match(planView, /padStart\(3, '0'\)/);
  assert.match(executionView, /当前项目：/);
  assert.match(executionView, /方案编号/);
});

function decodeHtmlAttribute(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()];
    const codePoint = entity[1].toLowerCase() === 'x'
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return String.fromCodePoint(codePoint);
  });
}

test('keeps the supervision definition edit payload valid after HTML attribute decoding', { skip: !ejs }, async () => {
  const definition = {
    id: 'plan-1',
    status: 'active',
    object_name: '对象 & "说明" </script>',
    check_method: '证据材料核查',
    description: '检查内容',
    standard_items: [],
  };
  const html = await ejs.renderFile(path.join(viewRoot, 'supervision-definitions/index.ejs'), {
    definitions: [ definition ],
    standardItems: [],
    checkMethodOptions: [],
    user: { roles: [ { code: 'security_admin', projectId: null } ] },
    csrf: 'test-token',
  });
  const attribute = html.match(/data-definition="([^"]*)"/)?.[1];
  assert.ok(attribute);
  assert.deepEqual(JSON.parse(decodeHtmlAttribute(attribute)), definition);
});

test('escapes standard content before placing supervision definitions in script data', { skip: !ejs }, async () => {
  const attackText = '</script><script>alert(1)</script>';
  const html = await ejs.renderFile(path.join(viewRoot, 'supervision-executions/index.ejs'), {
    project: { id: 'project-1', name: '测试项目' },
    user: { roles: [ { projectId: 'project-1', code: 'operator' } ] },
    executions: [],
    definitions: [ {
      id: 'plan-1',
      object_name: '检查对象',
      check_method: '证据材料核查',
      standard_items: [ { id: 'item-1', code: '6.1.1', title: attackText } ],
    } ],
    cloudCenters: [],
    csrf: 'test-token',
  });
  const json = html.match(/const executionDefinitions = ([^;]+);/)?.[1];
  assert.ok(json);
  const definitions = JSON.parse(json);
  assert.equal(definitions[0].standard_items[0].title, attackText);
  assert.equal(html.includes(attackText), false);
  assert.match(html, /heading\.textContent = \[item\.code, item\.title\]/);
});

test('links the plan page to manual threshold and optional AI deduplication', () => {
  const planView = fs.readFileSync(path.join(viewRoot, 'supervision-definitions/index.ejs'), 'utf8');
  const dedupeView = fs.readFileSync(path.join(viewRoot, 'dedupe/index.ejs'), 'utf8');
  const historyView = fs.readFileSync(path.join(viewRoot, 'dedupe/history.ejs'), 'utf8');
  assert.match(planView, /href="\/dedupe"/);
  assert.match(planView, /检查方案去重复核/);
  assert.match(dedupeView, /id="definitionThreshold"/);
  assert.match(dedupeView, /运行规则筛选/);
  assert.match(dedupeView, /可选 AI 语义复核/);
  assert.match(dedupeView, /每批最多 4 组/);
  assert.match(dedupeView, /definitionAiProgressModal/);
  assert.match(dedupeView, /保留 A 并合并/);
  assert.match(dedupeView, /保留 B 并合并/);
  assert.match(dedupeView, /definitions?\/history|\/dedupe\/history/);
  assert.match(historyView, /检查方案去重复核历史/);
});

test('links the center object page to manual object deduplication', () => {
  const html = fs.readFileSync(path.join(viewRoot, 'supervision-center-objects/index.ejs'), 'utf8');
  assert.match(html, /\/supervision-center-objects\/dedupe/);
  assert.match(html, /对象去重复核/);
});

test('keeps rule scanning manual, AI optional, and manual review always available', () => {
  const html = fs.readFileSync(path.join(viewRoot, 'supervision-center-objects/dedupe.ejs'), 'utf8');
  assert.match(html, /按名称相似度规则筛选后，可直接由人工判断是否重复/);
  assert.match(html, /AI 语义复核为可选辅助/);
  assert.match(html, /运行规则筛选/);
  assert.match(html, /type="number" min="0" max="1" step="0.01"/);
  assert.match(html, /进入页面不会自动扫描/);
  assert.match(html, /AI 不是合并前置条件/);
  assert.match(html, /规则筛选结果/);
  assert.match(html, /保留 A 并合并/);
  assert.match(html, /保留 B 并合并/);
  assert.match(html, /不是重复/);
  assert.match(html, /暂不确定/);
  assert.match(html, /可选 AI 分析/);
  assert.match(html, /objectAiProgressModal/);
  assert.match(html, /AI 语义复核进度/);
  assert.match(html, /每批最多 4 组/);
  assert.match(html, /batchSize: 4/);
  assert.match(html, /objectAiProgressBar/);
  assert.match(html, /object-filter-cards/);
  assert.match(html, /filterUrl\('ai_duplicate'\)/);
  assert.match(html, /filterUrl\('ai_excluded'\)/);
  assert.match(html, /filterUrl\('ai_pending'\)/);
  assert.match(html, /当前：/);
  assert.match(html, /object-review-actions/);
  assert.match(html, /该中心下.*检查方案会更新到保留对象/);
  assert.match(html, /所有合并都必须人工确认/);
  assert.doesNotMatch(html, /AI 已排除<\/h3>/);
  assert.doesNotMatch(html, /最近人工复核/);
});

test('moves object dedupe history behind its own page', () => {
  const entry = fs.readFileSync(path.join(viewRoot, 'supervision-center-objects/index.ejs'), 'utf8');
  const dedupe = fs.readFileSync(path.join(viewRoot, 'supervision-center-objects/dedupe.ejs'), 'utf8');
  const history = fs.readFileSync(path.join(viewRoot, 'supervision-center-objects/dedupe-history.ejs'), 'utf8');
  assert.match(entry, /\/supervision-center-objects\/dedupe/);
  assert.match(dedupe, /dedupe\/history/);
  assert.match(dedupe, /查看复核历史/);
  assert.match(history, /中心检查对象去重复核历史/);
  assert.match(history, /检查方案已迁移/);
});

test('renders the center object page with shared layout inputs', { skip: !ejs }, async () => {
  const html = await ejs.renderFile(path.join(viewRoot, 'supervision-center-objects/index.ejs'), {
    centerObjects: [],
    centerOptions: [ '云中心' ],
    csrf: 'test-token',
    user: { display_name: '管理员', roles: [] },
    currentPath: '/supervision-center-objects',
  });
  assert.match(html, /中心检查对象/);
  assert.match(html, /name="center"/);
});
