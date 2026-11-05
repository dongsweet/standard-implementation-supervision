'use strict';

/**
 * 固定角色矩阵。角色数量保持稳定，业务模块只引用这些代码，不在页面上
 * 让管理员自由拼装权限，避免权限配置失控。
 */
const ROLE_DEFINITIONS = Object.freeze([
  { code: 'system_admin', name: '系统管理员', scope: 'global', description: '系统配置、用户与权限、项目及全部业务数据管理' },
  { code: 'audit_admin', name: '审计管理员', scope: 'global', description: '全局只读审计、监督检查和审计日志查看' },
  { code: 'security_admin', name: '安全管理员', scope: 'global', description: '规范目录、安全应答、持续监督和项目业务维护' },
  { code: 'project_admin', name: '项目管理员', scope: 'project', description: '项目范围内人员、章节负责人和业务内容维护' },
  { code: 'operator', name: '操作员', scope: 'project', description: '项目范围内执行分配的应答、证据和检查工作' },
]);

const ROLE_NAME_MAP = new Map(ROLE_DEFINITIONS.map(role => [ role.code, role.name ]));
const GLOBAL_READ = new Set([ 'system_admin', 'audit_admin', 'security_admin' ]);
const GLOBAL_WRITE = new Set([ 'system_admin', 'security_admin' ]);

function hasGlobalRole(roles, roleSet) {
  return roles.some(role => !role.projectId && roleSet.has(role.code));
}

function hasRole(roles, code, projectId = null) {
  return roles.some(role => role.code === code && (projectId === null ? !role.projectId : role.projectId === projectId));
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

function requireSystemAdmin(ctx) {
  if (!hasRole(ctx.state.roles || [], 'system_admin')) ctx.throw(403, '仅系统管理员可执行此操作');
}

function requireProjectAdmin(ctx, projectId) {
  const roles = ctx.state.roles || [];
  if (!hasRole(roles, 'system_admin') && !hasRole(roles, 'security_admin') && !hasRole(roles, 'project_admin', projectId)) {
    ctx.throw(403, '仅项目管理员可维护项目人员与权限');
  }
}

function requireProject(ctx, projectId, write = false) {
  const roles = ctx.state.roles || [];
  if (!(write ? canWriteProject(roles, projectId) : canReadProject(roles, projectId))) {
    ctx.throw(403, '无权访问此项目');
  }
}

module.exports = {
  ROLE_DEFINITIONS,
  ROLE_NAME_MAP,
  canReadProject,
  canWriteProject,
  hasGlobalRole,
  hasRole,
  requireGlobalRead,
  requireGlobalWrite,
  requireSystemAdmin,
  requireProject,
  requireProjectAdmin,
};
