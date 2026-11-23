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
