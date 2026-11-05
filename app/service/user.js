'use strict';

const Service = require('egg').Service;
const bcrypt = require('bcryptjs');
const UserRepository = require('../repository/user');
const { ROLE_DEFINITIONS } = require('../lib/authorization');

const GLOBAL_ROLE_CODES = new Set(ROLE_DEFINITIONS.filter(role => role.scope === 'global').map(role => role.code));

function required(value, label) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`${label}不能为空`);
  return result;
}

class UserService extends Service {
  get repository() {
    return new UserRepository(this.ctx.app.db);
  }

  async listUsers() {
    return this.repository.listUsers();
  }

  normalizeRoleCodes(value) {
    const values = Array.isArray(value) ? value : [ value ];
    return [ ...new Set(values.map(item => String(item || '').trim()).filter(item => GLOBAL_ROLE_CODES.has(item))) ];
  }

  validatePassword(password) {
    const result = String(password || '');
    if (result.length < 12) this.ctx.throw(400, '密码至少 12 位');
    return result;
  }

  async createUser(payload) {
    const username = required(payload.username, '用户名');
    const displayName = required(payload.displayName, '显示名称');
    const password = this.validatePassword(payload.password);
    try {
      return await this.repository.createUser({
        username,
        displayName,
        passwordHash: await bcrypt.hash(password, 12),
        globalRoleCodes: this.normalizeRoleCodes(payload.globalRoles),
      });
    } catch (error) {
      if (error.code === '23505') this.ctx.throw(409, '用户名已存在');
      throw error;
    }
  }

  async setActive(userId, isActive, actorId) {
    if (userId === actorId && !isActive) this.ctx.throw(400, '不能停用当前登录账号');
    const result = await this.repository.setActive(userId, isActive);
    if (!result) this.ctx.throw(404, '用户不存在');
    return result;
  }

  async resetPassword(userId, password) {
    const result = await this.repository.resetPassword(userId, await bcrypt.hash(this.validatePassword(password), 12));
    if (!result) this.ctx.throw(404, '用户不存在');
    return result;
  }

  async replaceGlobalRoles(userId, roleCodes) {
    const result = await this.ctx.app.db.query('SELECT id FROM users WHERE id = $1', [ userId ]);
    if (!result.rowCount) this.ctx.throw(404, '用户不存在');
    const normalizedRoles = this.normalizeRoleCodes(roleCodes);
    if (String(userId) === String(this.ctx.session.userId) && !normalizedRoles.includes('system_admin')) {
      this.ctx.throw(400, '不能移除当前登录账号的系统管理员角色');
    }
    await this.repository.replaceGlobalRoles(userId, normalizedRoles);
  }
}

module.exports = UserService;
