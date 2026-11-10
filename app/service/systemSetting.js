'use strict';

const Service = require('egg').Service;
const SystemSettingRepository = require('../repository/systemSetting');
const { decryptSecret, encryptSecret } = require('../lib/secretBox');

const KEYS = {
  enabled: 'ai_enabled',
  baseUrl: 'ai_base_url',
  model: 'ai_model',
  timeoutMs: 'ai_timeout_ms',
  apiKey: 'ai_api_key',
};

function normalizeBaseUrl(value) {
  const baseUrl = String(value || '').trim().replace(/\/+$/, '');
  if (!baseUrl) return '';
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('AI地址格式无效');
  }
  if (![ 'http:', 'https:' ].includes(parsed.protocol)) throw new Error('AI地址必须使用http或https');
  return baseUrl;
}

class SystemSettingService extends Service {
  get repository() {
    return new SystemSettingRepository(this.ctx.app.db);
  }

  async getAiConfig({ includeKey = true } = {}) {
    const rows = await this.repository.getMany(Object.values(KEYS));
    const value = key => rows.get(key)?.value;
    let apiKey = String(value(KEYS.apiKey) || '').trim();
    if (apiKey && apiKey.startsWith('v1:')) {
      try {
        apiKey = decryptSecret(apiKey, this.config.keys);
      } catch {
        if (includeKey) this.ctx.throw(409, 'AI API Key 无法解密，请在系统配置中重新填写');
        apiKey = '';
      }
    }
    const fallback = this.config.ai;
    const baseUrl = value(KEYS.baseUrl) || fallback.baseUrl || '';
    const model = value(KEYS.model) || fallback.model || '';
    const timeoutMs = Number(value(KEYS.timeoutMs) || fallback.timeoutMs || 30000);
    const enabledSetting = value(KEYS.enabled);
    const enabled = enabledSetting === 'true' && Boolean(baseUrl && model && apiKey);
    return {
      enabled,
      baseUrl,
      model,
      timeoutMs,
      apiKey: includeKey ? String(apiKey || fallback.apiKey || '').trim() : '',
    };
  }

  async getPublicAiSettings() {
    const rows = await this.repository.getMany(Object.values(KEYS));
    const config = await this.getAiConfig({ includeKey: false });
    return {
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      model: config.model,
      timeoutMs: config.timeoutMs,
      apiKeyConfigured: Boolean(rows.get(KEYS.apiKey)?.value || this.config.ai.apiKey),
      updatedAt: rows.get(KEYS.apiKey)?.updated_at || rows.get(KEYS.baseUrl)?.updated_at || null,
    };
  }

  async saveAiSettings(payload, userId) {
    let baseUrl;
    try {
      baseUrl = normalizeBaseUrl(payload.baseUrl);
    } catch (error) {
      this.ctx.throw(400, error.message);
    }
    const model = String(payload.model || '').trim();
    const timeoutMs = Number(payload.timeoutMs || 30000);
    if (model.length > 200) this.ctx.throw(400, '模型名称不能超过200个字符');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 180000) {
      this.ctx.throw(400, 'AI超时时间必须在5000到180000毫秒之间');
    }
    const enabled = payload.enabled === true || payload.enabled === 'true' || payload.enabled === 'on';
    if (enabled && (!baseUrl || !model)) this.ctx.throw(400, '启用AI时必须填写接口地址和模型名称');
    if (enabled && !String(payload.apiKey || '').trim()) {
      const existing = await this.repository.getMany([ KEYS.apiKey ]);
      if (!existing.get(KEYS.apiKey)?.value && !this.config.ai.apiKey) this.ctx.throw(400, '启用AI时必须填写API Key');
    }
    const entries = [
      { key: KEYS.enabled, value: enabled ? 'true' : 'false' },
      { key: KEYS.baseUrl, value: baseUrl },
      { key: KEYS.model, value: model },
      { key: KEYS.timeoutMs, value: String(timeoutMs) },
    ];
    const apiKey = String(payload.apiKey || '').trim();
    if (payload.clearApiKey === true || payload.clearApiKey === 'on' || payload.clearApiKey === 'true') {
      entries.push({ key: KEYS.apiKey, value: '', isSecret: true });
    } else if (apiKey) {
      entries.push({ key: KEYS.apiKey, value: encryptSecret(apiKey, this.config.keys), isSecret: true });
    }
    await this.repository.setMany(entries, userId);
  }

  async testAiConnection(payload = {}) {
    const stored = await this.getAiConfig({ includeKey: true });
    const candidateKey = String(payload.apiKey || '').trim() || stored.apiKey;
    let baseUrl;
    try {
      baseUrl = normalizeBaseUrl(payload.baseUrl || stored.baseUrl);
    } catch (error) {
      this.ctx.throw(400, error.message);
    }
    const model = String(payload.model || stored.model || '').trim();
    const timeoutMs = Number(payload.timeoutMs || stored.timeoutMs || 30000);
    if (!baseUrl || !model || !candidateKey) this.ctx.throw(400, '请先填写接口地址、模型和API Key');
    const { AiProvider } = require('../lib/aiProvider');
    const provider = new AiProvider({ baseUrl, model, apiKey: candidateKey, timeoutMs });
    return provider.testConnection();
  }
}

module.exports = SystemSettingService;
