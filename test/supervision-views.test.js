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
  assert.match(planView, /id="definitionObjectFilter"/);
  assert.match(planView, /name="objectId"/);
  assert.match(planView, /createPlanObjectFilter/);
  assert.match(planView, /输入检查对象、别名或分类筛选/);
  assert.match(planView, /请从检查对象候选中选择/);

  assert.match(planView, /name="priority"/);
  assert.match(planView, /name="checkMethod"/);
  assert.match(planView, /name="scope"/);
  assert.match(planView, /name="centers"/);
  assert.match(planView, /适用机构/);
  assert.match(planView, /<%= centerOption %>/);
  assert.match(planView, /name="status"/);
  assert.match(planView, /buildPageUrl\(pageValue - 1\)/);
  assert.match(planView, /definitionDetailModal/);
  assert.match(planView, /padStart\(3, '0'\)/);
  assert.match(planView, /<td><strong><%= definition\.object_name %><\/strong><\/td>/);
  assert.doesNotMatch(planView, /<%= definition\.scope \|\| '-' %>/);
  assert.match(planView, /<div title="<%= definition\.description %>" style="display:-webkit-box;[\s\S]*-webkit-line-clamp:4/);
  assert.match(planView, /definition\.scope \? \[ \[ '检查范围', definition\.scope \] \] : \[\]/);
  assert.match(planView, /\['对象分类', definition\.object_category \|\| '未指定'\]/);
  assert.match(planView, /\['检查层面', definition\.check_layer \|\| '未指定'\]/);
  assert.doesNotMatch(planView, /范围 \/ 分类 \/ 层面/);
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

test('redirects after a plan update without showing a redundant success notice', () => {
  const controller = fs.readFileSync(path.join(__dirname, '../app/controller/supervisionDefinition.js'), 'utf8');
  const updateMethod = controller.match(/async update\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(updateMethod, /this\.ctx\.redirect\('\/supervision-definitions'\);/);
  assert.doesNotMatch(updateMethod, /notice=/);
  assert.doesNotMatch(controller, /监督定义已更新/);
  assert.match(controller, /监督定义已创建/);
});

test('uses branch terminology across supervision and project views', () => {
  const views = [
    'layout.ejs',
    'home/index.ejs',
    'cloud-centers/index.ejs',
    'projects/index.ejs',
    'projects/manage.ejs',
    'supervision-definitions/index.ejs',
    'supervision-center-objects/index.ejs',
    'supervision-center-objects/dedupe.ejs',
    'supervision-center-objects/dedupe-history.ejs',
    'supervision-executions/index.ejs',
    'supervision-plan-imports/review.ejs',
  ].map(file => fs.readFileSync(path.join(viewRoot, file), 'utf8')).join('\n')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');
  for (const legacyText of [
    '云中心',
    '中心检查对象',
    '检查中心',
    '适用中心',
    '未指定中心',
    '本次检查中心',
    '具体云中心',
    '安评中心',
  ]) {
    assert.equal(views.includes(legacyText), false, `legacy term remains: ${legacyText}`);
  }
  assert.match(views, /分支机构管理/);
  assert.match(views, /检查对象/);
  assert.match(views, /适用机构/);
});

test('groups the plan editor into three compact source-aligned tabs', () => {
  const planView = fs.readFileSync(path.join(viewRoot, 'supervision-definitions/index.ejs'), 'utf8');
  assert.match(planView, /id="editBasicTab"/);
  assert.match(planView, /id="editRequirementTab"/);
  assert.match(planView, /id="editStandardsTab"/);
  assert.match(planView, /id="editCenters"[\s\S]*name="centers"/);
  assert.match(planView, /id="editCheckMethods"[\s\S]*name="checkMethods"/);
  assert.match(planView, /<input type="hidden" id="editScope" name="scope">/);
  assert.doesNotMatch(planView, /id="editScope"[^>]*type="text"/);
  assert.match(planView, /id="editObjectName"[\s\S]*list="editObjectOptions"/);
  assert.match(planView, /id="editObjectCategoryCombobox"/);
  assert.match(planView, /id="editObjectCategory"[\s\S]*role="combobox"[\s\S]*aria-controls="editObjectCategoryMenu"/);
  assert.match(planView, /id="editObjectCategoryToggle"/);
  assert.match(planView, /id="editObjectCategoryMenu"/);
  assert.match(planView, /id="editCheckLayer"[\s\S]*list="editCheckLayerOptions"/);
  assert.match(planView, /id="editFrequency"[\s\S]*list="editFrequencyOptions"/);
  assert.match(planView, />执行频率</);
  assert.match(planView, />远程\/现场查看</);
  assert.match(planView, />检查项描述</);
  assert.match(planView, /<details class="border-top pt-3"><summary class="text-secondary">其他参考信息（可选）<\/summary>/);
  assert.match(planView, /standard-picker/);
  assert.match(planView, /standard-picker-results \{ position: relative; z-index: 1085; width: 100%; max-height: 13rem; overflow-y: auto; \}/);
  assert.match(planView, /editStandardChips/);
  assert.match(planView, /editStandardSearch/);
  assert.match(planView, /输入标准编号、条款编号或内容搜索/);
  assert.doesNotMatch(planView, /<select class="form-select" id="editStandardItems" multiple size="12">/);
  assert.match(planView, /editStandardItemCount/);
  assert.match(planView, /class StandardItemPicker/);
  assert.match(planView, /resolvePlanObject/);
  assert.match(planView, /showPlanFormTab/);
});

test('keeps plan object and category independent while category remains searchable', () => {
  const planView = fs.readFileSync(path.join(viewRoot, 'supervision-definitions/index.ejs'), 'utf8');
  for (const prefix of [ 'create', 'edit' ]) {
    assert.match(planView, new RegExp(`id="${prefix}ObjectCategoryCombobox"`));
    assert.match(planView, new RegExp(`id="${prefix}ObjectCategory" name="objectCategory" type="search"`));
    assert.match(planView, new RegExp(`id="${prefix}ObjectCategoryToggle"`));
    assert.match(planView, new RegExp(`id="${prefix}ObjectCategoryMenu"`));
    assert.doesNotMatch(planView, new RegExp(`id="${prefix}ObjectCategory"[^>]*list="`));
  }
  assert.doesNotMatch(planView, /CategoryOptions"><% objectCategoriesValue/);
  assert.match(planView, /const planCategoryCatalog =/);
  assert.match(planView, /categoryInputMatches/);
  assert.match(planView, /function initializePlanCategoryPicker\(prefix\)/);
  assert.match(planView, /input\.addEventListener\('input', renderMatches\)/);
  assert.match(planView, /独立选择对象分类，不改变检查对象/);
  assert.match(planView, /ArrowDown/);
  assert.match(planView, /ArrowUp/);
  assert.match(planView, /Escape/);
  assert.match(planView, /请从分类候选中选择一个对象分类，或清空分类筛选/);
  assert.doesNotMatch(planView, /objectInput\.value = '';\s*populateObjectOptions/);
  assert.doesNotMatch(planView, /categoryInput\.value = '';/);
  assert.doesNotMatch(planView, /对象分类必须与所选检查对象关联/);
  assert.doesNotMatch(planView, /先选分类会筛选检查对象/);
});

test('renders joint review page with a single optional scope filter', { skip: !ejs }, async () => {
  const html = await ejs.renderFile(path.join(viewRoot, 'joint-reviews/index.ejs'), {
    definitionId: '00000000-0000-0000-0000-000000000001',
    objectId: '',
    standardItemId: '',
    projectId: '',
    reviewType: '',
    humanDecision: '',
    reviews: [],
    summary: { total: 0, error: 0, warning: 0, pending: 0, aiCompleted: 0 },
    csrf: 'test-token',
  });
  assert.match(html, /联合复核/);
  assert.match(html, /name="definitionId" value="00000000-0000-0000-0000-000000000001"/);
  assert.doesNotMatch(html, /objectId is not defined/);
});

test('provides context links to the joint review workbench from plans, objects, and standard items', () => {
  const planView = fs.readFileSync(path.join(viewRoot, 'supervision-definitions/index.ejs'), 'utf8');
  const objectView = fs.readFileSync(path.join(viewRoot, 'supervision-center-objects/index.ejs'), 'utf8');
  const standardView = fs.readFileSync(path.join(viewRoot, 'standards/version.ejs'), 'utf8');
  const jointView = fs.readFileSync(path.join(viewRoot, 'joint-reviews/index.ejs'), 'utf8');
  assert.match(planView, /detailJointReviewLink/);
  assert.match(planView, /\/joint-reviews\?definitionId=/);
  assert.match(objectView, /\/joint-reviews\?objectId=/);
  assert.match(standardView, /\/joint-reviews\?standardItemId=/);
  assert.match(jointView, /规则先生成候选/);
  assert.match(jointView, /AI 提供辅助判断/);
  assert.match(jointView, /所有结论由人工确认/);
  assert.match(jointView, /不会自动修改标准、项目应答、检查方案或规范对象/);
  assert.match(jointView, /runJointAiReview/);
  assert.match(jointView, /jointHumanDecision/);
  assert.match(jointView, /\.joint-review-table \{ min-width: 82rem; table-layout: fixed; \}/);
  assert.match(jointView, /joint-col-context/);
  assert.match(jointView, /joint-review-context-json/);
  assert.match(jointView, /confirmed problem|确认不匹配/);
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

test('organizes canonical objects, pending classification, and category maintenance in one workbench', () => {
  const html = fs.readFileSync(path.join(viewRoot, 'supervision-center-objects/index.ejs'), 'utf8');
  assert.match(html, /对象总览/);
  assert.match(html, /待整理对象/);
  assert.match(html, /分类维护/);
  assert.match(html, /规范对象、原始名称或分类/);
  assert.match(html, /适用机构/);
  assert.match(html, /<%= option %>/);
  assert.match(html, /id="createCategoryModal"/);
  assert.match(html, /data-bs-target="#createCategoryModal"/);
  assert.match(html, /包含规范对象/);
  assert.match(html, /category-object-list/);
  assert.match(html, /\.category-object-list \{ max-height: 11rem; overflow-y: auto;/);
  assert.match(html, /展开全部 <%= categoryObjects\.length %> 个/);
  assert.match(html, /function toggleCategoryObjects/);
  assert.match(html, /function filterObjectCategory/);
  assert.doesNotMatch(html, /<div class="col-12 col-lg-4"><div class="card"><div class="card-header"><h3 class="card-title">新增对象分类/);
  assert.match(html, /deleteObjectCategory/);
  assert.match(html, /id="editObjectCategoryCombobox"/);
  assert.match(html, /id="objectMergeModal"/);
  assert.match(html, /href="\/supervision-center-objects\/split-drafts"/);
  assert.match(html, /拆分草案保存失败/);
  assert.match(html, /supervision-center-objects\/split-drafts\/' \+ encodeURIComponent\(payload\.data\.id\)/);
  assert.match(html, /id="objectSplitModal"/);
  assert.match(html, /split-drafts\/' \+ encodeURIComponent\(payload\.data\.id\)/);
  assert.match(html, /本版仅生成拆分草案，不修改业务数据/);
  assert.match(html, /onclick="openSplitObject\(this\)"/);
  assert.match(html, /拆分草案/);
  assert.match(html, /只勾选本次要拆出的检查方案/);
  assert.match(html, /未勾选的方案会继续保留在来源对象/);
  assert.match(html, /同一个检查方案不能出现在多个拆分目标/);
  assert.match(html, /拆出 \$\{plans\.size\} 个 · 保留在来源对象 \$\{remain\} 个/);
  assert.doesNotMatch(html, /拆分目标没有覆盖来源对象的全部检查方案/);
  assert.doesNotMatch(html, /mergeSplitGroups/);
  assert.doesNotMatch(html, /split-group-select/);
  assert.doesNotMatch(html, /split-group-include/);
  assert.doesNotMatch(html, /合并选中的分组/);
  assert.match(html, /本版仅生成拆分草案，不修改业务数据/);
  assert.match(html, /id="mergeTargetObject"/);
  assert.match(html, /id="mergeTargetObjectMenu"/);
  assert.match(html, /mergeObjectPicker/);
  assert.match(html, /name: item\.canonical_name \|\| item\.name \|\| ''/);
  assert.match(html, /onclick="openMergeObject\(this\)"/);
  assert.match(html, /来源对象的检查方案会迁移到保留对象/);
  assert.match(html, /确认合并规范对象/);
  assert.match(html, /object-category-combobox-menu \{ position: absolute; z-index: 1050; top: calc\(100% \+ 4px\); left: 0; right: 0; max-height: 180px;/);
  assert.match(html, /data-categories="<%= encodeURIComponent\(JSON\.stringify\(Object\.entries\(\(row\.plans \|\| \[\]\)\.reduce\(/);
  assert.match(html, /const objectEditCategories =/);
  assert.match(html, /data-plan-count="<%= row\.plan_count %>"/);
  assert.match(html, /\$\{item\.planCount\} \/ \$\{totalPlanCount\} 个检查方案/);
  assert.match(html, /现有分类/);
  assert.match(html, /保存时采用为此分类/);
  assert.match(html, /subtitle\.textContent = '现有分类'/);
  assert.doesNotMatch(html, /:\s*`\$\{item\.count\} 个规范对象`/);
  assert.match(html, /objectEditPicker\.setHistorical\(history, Number\(button\.dataset\.planCount\) \|\| 0\)/);
  assert.match(html, /categoryName: exact \? '' : categoryName/);
  assert.doesNotMatch(html, /<select class="form-select" id="editCategoryId" name="categoryId">/);
  assert.match(html, /name="categoryInput"/);
  assert.match(html, /id="objectCategoryCombobox"/);
  assert.match(html, /class="object-plan-number"/);
  assert.match(html, /id="objectPlanPopover"/);
  assert.match(html, /showObjectPlanPreview/);
  assert.match(html, /检查方案 /);
  assert.match(html, /\[ '适用机构', \(plan\.centers \|\| \[\]\)\.join\('、'\) \]/);
  assert.match(html, /检查描述/);
  assert.match(html, /检查步骤/);
  assert.match(html, /频率 \/ 方式/);
  assert.match(html, /#objectPlanPopover \{ position: fixed; inset: auto;[\s\S]*margin: 0;/);
  assert.match(html, /popover\.getBoundingClientRect\(\)/);
  assert.match(html, /triggerRect\.bottom \+ horizontalGap/);
  assert.match(html, /triggerRect\.top - popoverRect\.height - horizontalGap/);
  assert.match(html, /popover\.showPopover\(\)/);
  assert.match(html, /addEventListener\('mouseover'[\s\S]*object-plan-number/);
  assert.match(html, /addEventListener\('focusin'[\s\S]*object-plan-number/);
  assert.match(html, /addEventListener\('pointerdown'[\s\S]*objectPopover\.hidePopover\(\)[\s\S]*\}, true\)/);
  assert.match(html, /const resetUrl = targetView => buildUrl\(targetView, 1, \{[\s\S]*center: '',[\s\S]*search: '',[\s\S]*categoryInput: ''/);
  assert.match(html, /href="<%= resetUrl\(viewValue\) %>">重置<\/a>/);
  assert.doesNotMatch(html, /href="<%= buildUrl\(viewValue\) %>">重置<\/a>/);
  assert.match(html, /class="object-category-combobox"/);
  assert.match(html, /id="objectCategoryToggle"/);
  assert.match(html, /id="objectCategoryMenu"/);
  assert.match(html, /class="visually-hidden" id="objectCategorySearchStatus" role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /class="form-text" id="objectCategorySearchStatus"/);
  assert.match(html, /placeholder="输入对象分类名称筛选"/);
  assert.match(html, /paint\(options, '暂无可选分类'\)/);
  assert.match(html, /可直接选择或输入名称筛选/);
  assert.doesNotMatch(html, /paint\(\[\], '输入对象分类名称后筛选'\)/);
  assert.match(html, /ArrowDown/);
  assert.match(html, /ArrowUp/);
  assert.match(html, /Escape/);
  assert.match(html, /请从分类候选中选择一个对象分类/);
  assert.doesNotMatch(html, /list="objectCategoryOptions"/);
  assert.doesNotMatch(html, /name="category"><option value="">全部分类/);
  assert.match(html, /Number\(item\.object_count\) === 0/);
  assert.match(html, /categories\/.*\/delete/);
  assert.match(html, /规范对象名称/);
  assert.match(html, /对象分类/);
  assert.match(html, /objectCategoriesValue = Array\.isArray\(typeof objectCategories/);
  assert.match(html, /centerObjectsValue = Array\.isArray\(typeof centerObjects/);
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
  assert.match(html, /该机构下.*检查方案会更新到保留对象/);
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
  assert.match(history, /检查对象去重复核历史/);
  assert.match(history, /检查方案已迁移/);
});

test('renders the inspection object page with branch terminology', { skip: !ejs }, async () => {
  const html = await ejs.renderFile(path.join(viewRoot, 'supervision-center-objects/index.ejs'), {
    centerObjects: [],
    centerOptions: [ '云中心' ],
    csrf: 'test-token',
    user: { display_name: '管理员', roles: [] },
    currentPath: '/supervision-center-objects',
  });
  assert.match(html, /检查对象/);
  assert.match(html, /name="center"/);
  assert.match(html, /云中心/);
  assert.doesNotMatch(html, /中心检查对象/);
});
