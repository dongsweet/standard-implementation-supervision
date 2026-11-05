'use strict';

const Controller = require('egg').Controller;
const bcrypt = require('bcryptjs');

class AuthController extends Controller {
  async show() {
    await this.ctx.render('auth/login', { title: '登录 - 安全规范落实与持续监管系统', csrf: this.ctx.csrf }, { layout: false });
  }

  async login() {
    const { username, password } = this.ctx.request.body || {};
    if (!username || !password) this.ctx.throw(400, '请输入用户名和密码');
    const result = await this.app.db.query('SELECT id, username, display_name, password_hash FROM users WHERE username = $1 AND is_active = true', [ String(username).trim() ]);
    const user = result.rows[0];
    if (!user || !await bcrypt.compare(String(password), user.password_hash)) this.ctx.throw(401, '用户名或密码错误');
    this.ctx.session.userId = user.id;
    this.ctx.redirect('/');
  }

  async logout() {
    this.ctx.session = null;
    this.ctx.redirect('/login');
  }
}

module.exports = AuthController;
