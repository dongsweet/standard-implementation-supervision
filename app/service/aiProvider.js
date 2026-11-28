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

  async classifyDefinitionPairs(items) {
    const provider = await this.getProvider();
    return provider.classifyDefinitionPairs(items);
  }

  async classifyCenterObjectPair(payload) {
    const provider = await this.getProvider();
    return provider.classifyCenterObjectPair(payload);
  }

  async classifySemanticInspectionPairs(items) {
    const provider = await this.getProvider();
    return provider.classifySemanticInspectionPairs(items);
  }

  async classifyCenterObjectPairs(items) {
    const provider = await this.getProvider();
    return provider.classifyCenterObjectPairs(items);
  }

  async reviewJointIssue(context) {
    const provider = await this.getProvider();
    return provider.reviewJointIssue(context);
  }

  async testConnection() {
    const provider = await this.getProvider();
    return provider.testConnection();
  }

  async reviewStandardNodes(nodes, context) {
    const provider = await this.getProvider();
    return provider.reviewStandardNodes(nodes, context);
  }
}

module.exports = AiProviderService;
