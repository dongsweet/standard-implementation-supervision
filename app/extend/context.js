'use strict';

const path = require('node:path');
const ejs = require('ejs');

module.exports = {
  async render(template, locals = {}, options = {}) {
    const file = path.join(this.app.baseDir, 'app', 'view', `${template}.ejs`);
    const state = this.state || {};
    const data = { ...state, ...locals };
    const content = await ejs.renderFile(file, data, { async: true });
    this.type = 'html';
    if (options.layout === false) {
      this.body = content;
      return;
    }
    const layoutFile = path.join(this.app.baseDir, 'app', 'view', 'layout.ejs');
    this.body = await ejs.renderFile(layoutFile, {
      ...data,
      bodyContent: content,
      currentPath: this.path,
    }, { async: true });
  },
};
