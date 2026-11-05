'use strict';

const Controller = require('egg').Controller;
const { ROLE_DEFINITIONS, requireSystemAdmin } = require('../lib/authorization');

class UserController extends Controller {
  async index() {
    requireSystemAdmin(this.ctx);
    await this.ctx.render('users/index', {
      title: '用户与权限',
      users: await this.ctx.service.user.listUsers(),
      roles: ROLE_DEFINITIONS,
      csrf: this.ctx.csrf,
    });
  }

  async create() {
    requireSystemAdmin(this.ctx);
    await this.ctx.service.user.createUser(this.ctx.request.body || {});
    this.ctx.redirect('/users');
  }

  async toggleActive() {
    requireSystemAdmin(this.ctx);
    const isActive = String(this.ctx.request.body.isActive || '') === 'true';
    await this.ctx.service.user.setActive(this.ctx.params.userId, isActive, this.ctx.session.userId);
    this.ctx.redirect('/users');
  }

  async resetPassword() {
    requireSystemAdmin(this.ctx);
    await this.ctx.service.user.resetPassword(this.ctx.params.userId, this.ctx.request.body.password);
    this.ctx.redirect('/users');
  }

  async replaceRoles() {
    requireSystemAdmin(this.ctx);
    await this.ctx.service.user.replaceGlobalRoles(this.ctx.params.userId, this.ctx.request.body.globalRoles);
    this.ctx.redirect('/users');
  }
}

module.exports = UserController;
