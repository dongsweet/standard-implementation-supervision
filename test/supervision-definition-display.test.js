'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const planView = fs.readFileSync(
  path.join(__dirname, '../app/view/supervision-definitions/index.ejs'),
  'utf8'
);

test('removes the empty internal scope placeholder below plan objects', () => {
  assert.match(planView, /<td><strong><%= definition\.object_name %><\/strong><\/td>/);
  assert.doesNotMatch(planView, /<%= definition\.scope \|\| '-' %>/);
});

test('wraps plan descriptions instead of truncating them to one line', () => {
  assert.match(planView, /title="<%= definition\.description %>"[\s\S]*white-space:normal[\s\S]*-webkit-line-clamp:4/);
  assert.doesNotMatch(planView, /class="text-truncate" style="max-width:300px" title="<%= definition\.description %>"/);
});
