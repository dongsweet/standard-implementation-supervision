'use strict';

const Service = require('egg').Service;
const { AiProvider } = require('../lib/aiProvider');

class AiProviderService extends Service {
  get provider() {
    if (!this._provider) this._provider = new AiProvider(this.config.ai);
    return this._provider;
  }

  async classifyPair(left, right) {
    return this.provider.classifyPair(left, right);
  }
}

module.exports = AiProviderService;
