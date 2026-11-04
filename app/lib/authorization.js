'use strict';

const GLOBAL_READ = new Set([ 'system_admin', 'audit_admin', 'security_admin' ]);
const GLOBAL_WRITE = new Set([ 'system_admin', 'security_admin' ]);

function hasGlobalRole(roles, roleSet) {
  return roles.some(role => !role.projectId && roleSet.has(role.code));
}

function hasProjectRole(roles, projectId) {
  return roles.some(role => role.projectId === projectId && [ 'project_admin', 'operator' ].includes(role.code));
}

function canReadProject(roles, projectId) {
  return hasGlobalRole(roles, GLOBAL_READ) || hasProjectRole(roles, projectId);
}

function canWriteProject(roles, projectId) {
  return hasGlobalRole(roles, GLOBAL_WRITE) || roles.some(role => role.projectId === projectId && role.code === 'project_admin');
}

function requireGlobalRead(ctx) {
  if (!hasGlobalRole(ctx.state.roles || [], GLOBAL_READ)) ctx.throw(403, '无权访问此功能');
}

function requireGlobalWrite(ctx) {
  if (!hasGlobalRole(ctx.state.roles || [], GLOBAL_WRITE)) ctx.throw(403, '无权执行此操作');
}

function requireProject(ctx, projectId, write = false) {
  const roles = ctx.state.roles || [];
  if (!(write ? canWriteProject(roles, projectId) : canReadProject(roles, projectId))) {
    ctx.throw(403, '无权访问此项目');
  }
}

module.exports = { canReadProject, canWriteProject, hasGlobalRole, requireGlobalRead, requireGlobalWrite, requireProject };
