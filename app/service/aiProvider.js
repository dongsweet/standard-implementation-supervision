'use strict';

const Service = require('egg').Service;
const { AiProvider } = require('../lib/aiProvider');

class AiProviderService extends Service {
  async getProvider() {
    const config = await this.ctx.service.systemSetting.getAiConfig({ includeKey: true });
    return new AiProvider(config);
  }

  async classifyPair(left, right) {
    const provider = await this.getProvider();
    return provider.classifyPair(left, right);
  }

  async testConnection() {
    const provider = await this.getProvider();
    return provider.testConnection();
  }

  async correctStandardNodes(nodes, context) {
    const provider = await this.getProvider();
    return provider.correctStandardNodes(nodes, context);
  }

  async reviewStandardNodes(nodes, context) {
    const provider = await this.getProvider();
    return provider.reviewStandardNodes(nodes, context);
  }
}

module.exports = AiProviderService;
