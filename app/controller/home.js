'use strict';

const Controller = require('egg').Controller;

class HomeController extends Controller {
  async index() {
    await this.ctx.render('home/index', { title: '安全规范落实与持续监管系统', user: this.ctx.state.user, csrf: this.ctx.csrf });
  }

  async health() {
    let database = 'ok';
    try {
      await this.app.db.query('SELECT 1');
    } catch (err) {
      database = 'unavailable';
      this.ctx.app.emit('error', err, this.ctx);
    }
    this.ctx.body = { status: database === 'ok' ? 'ok' : 'degraded', database };
    this.ctx.status = database === 'ok' ? 200 : 503;
  }
}

module.exports = HomeController;
