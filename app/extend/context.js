'use strict';

const path = require('node:path');
const ejs = require('ejs');

module.exports = {
  async render(template, locals = {}) {
    const file = path.join(this.app.baseDir, 'app', 'view', `${template}.ejs`);
    const state = this.state || {};
    const data = { ...state, ...locals };
    this.type = 'html';
    this.body = await ejs.renderFile(file, data, { async: true });
  },
};
