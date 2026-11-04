'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canReadProject, canWriteProject } = require('../app/lib/authorization');

test('global roles and project roles have separate scopes', () => {
  const roles = [
    { code: 'audit_admin', scope: 'global', projectId: null },
    { code: 'operator', scope: 'project', projectId: 'project-a' },
  ];
  assert.equal(canReadProject(roles, 'project-b'), true);
  assert.equal(canWriteProject(roles, 'project-b'), false);
  assert.equal(canReadProject([{ code: 'operator', projectId: 'project-a' }], 'project-b'), false);
  assert.equal(canWriteProject([{ code: 'project_admin', projectId: 'project-a' }], 'project-a'), true);
});
