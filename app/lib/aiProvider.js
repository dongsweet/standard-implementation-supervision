'use strict';

function aiError(message, code, extra = {}) {
  const error = new Error(message);
  error.aiCode = code;
  Object.assign(error, extra);
  return error;
}

function providerHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return '配置的AI地址';
  }
}

function friendlyAiError(error, baseUrl = '') {
  const code = error.aiCode || error.cause?.code || error.code || '';
  const host = providerHost(baseUrl);
  const status = error.providerStatus || error.status;
  if (code === 'AI_CONFIG_ERROR') return { statusCode: 400, code, message: error.message };
  if ([ 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'AI_TIMEOUT' ].includes(code)) {
    return { statusCode: 504, code: 'AI_CONNECT_TIMEOUT', message: `连接AI服务 ${host} 超时，请检查服务地址、网络访问和防火墙。` };
  }
  if (code === 'ENOTFOUND') return { statusCode: 502, code, message: `无法解析AI服务域名 ${host}，请检查地址或DNS。` };
  if ([ 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH' ].includes(code)) {
    return { statusCode: 502, code, message: `无法连接AI服务 ${host}（${code}），请确认服务已启动且网络可达。` };
  }
  if (/certificate|CERT_|TLS|SSL/i.test(String(code)) || /certificate|TLS|SSL/i.test(error.message)) {
    return { statusCode: 502, code: 'AI_TLS_ERROR', message: `连接AI服务 ${host} 时证书校验失败，请检查HTTPS证书。` };
  }
  if (status === 401 || status === 403) {
    return { statusCode: 502, code: 'AI_AUTH_ERROR', message: 'AI服务拒绝了当前API Key，请检查密钥、模型权限和账户状态。' };
  }
  if (status === 404) return { statusCode: 502, code: 'AI_ENDPOINT_NOT_FOUND', message: 'AI接口返回404，请确认接口地址是否需要包含或省略 /v1、/chat/completions。' };
  if (status === 429) return { statusCode: 502, code: 'AI_RATE_LIMIT', message: 'AI服务请求过于频繁或额度不足，请稍后重试或检查账户额度。' };
  if (status && status >= 500) return { statusCode: 502, code: 'AI_UPSTREAM_ERROR', message: `AI服务暂时不可用（HTTP ${status}），请稍后重试。` };
  if (code === 'AI_INVALID_RESPONSE') return { statusCode: 502, code, message: error.message };
  if (error.message === 'fetch failed' || code.startsWith?.('UND_ERR')) {
    return { statusCode: 502, code: 'AI_NETWORK_ERROR', message: `无法连接AI服务 ${host}，请检查网络连通性。` };
  }
  return { statusCode: 502, code: 'AI_REQUEST_FAILED', message: error.message || 'AI服务请求失败' };
}

class AiProvider {
  constructor(config) {
    this.config = config;
  }

  get enabled() {
    return this.config.enabled !== false && Boolean(this.config.baseUrl && this.config.apiKey && this.config.model);
  }

  assertSafeBaseUrl() {
    const url = new URL(this.config.baseUrl);
    const hostname = url.hostname.toLowerCase();
    const isLoopback = [ 'localhost', '127.0.0.1', '::1' ].includes(hostname);
    if (url.protocol === 'http:' && !isLoopback && process.env.NODE_ENV === 'production') {
      throw aiError('生产环境的AI接口必须使用HTTPS；内网HTTP地址仅允许localhost回环地址', 'AI_CONFIG_ERROR');
    }
  }

  async request(messages) {
    this.assertSafeBaseUrl();
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs || 30000);
    try {
      const endpoint = this.config.baseUrl.replace(/\/$/, '');
      const response = await fetch(endpoint.endsWith('/chat/completions') ? endpoint : `${endpoint}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          max_tokens: Number(this.config.maxTokens || 2000),
          response_format: { type: 'json_object' },
          messages,
        }),
      });
      if (!response.ok) {
        let detail = '';
        try {
          const body = await response.text();
          detail = body.replace(/\s+/g, ' ').slice(0, 240);
        } catch {
          // Keep the HTTP status when the provider response is not readable.
        }
        throw aiError(`AI HTTP ${response.status}${detail ? ': ' + detail : ''}`, 'AI_HTTP_ERROR', { providerStatus: response.status });
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw aiError('AI接口返回的内容不是JSON，请确认接口地址指向兼容的Chat Completions服务。', 'AI_INVALID_RESPONSE');
      }
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw aiError('AI返回内容为空', 'AI_INVALID_RESPONSE');
      return {
        content,
        providerStatus: response.status,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      error.durationMs = Date.now() - startedAt;
      error.baseUrl = this.config.baseUrl;
      if (!error.aiCode && error.name === 'AbortError') error.aiCode = 'AI_TIMEOUT';
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async classifyPair(left, right) {
    if (!this.enabled) return { result: { relation: 'uncertain', confidence: 0, differences: [], reason: 'AI 服务未配置', recommendedCanonicalId: null }, providerStatus: null, durationMs: 0 };
    const response = await this.request([
      { role: 'system', content: '你是监督检查定义去重助手。只判断语义是否等价，不修改数据。必须返回 JSON：relation、confidence、differences、reason、recommendedCanonicalId。' },
      { role: 'user', content: JSON.stringify({ left, right }) },
    ]);
    return { result: parseAiResult(response.content), providerStatus: response.providerStatus, durationMs: response.durationMs };
  }

  async testConnection() {
    if (!this.enabled) throw aiError('AI服务未完整配置', 'AI_CONFIG_ERROR');
    const response = await this.request([
      { role: 'system', content: '只返回 JSON，不要附加说明。' },
      { role: 'user', content: '请返回 {"status":"ok"}。' },
    ]);
    let json;
    try {
      json = parseJsonContent(response.content);
    } catch {
      throw aiError('AI返回的不是有效JSON', 'AI_INVALID_RESPONSE');
    }
    if (json.status !== 'ok') throw aiError('AI返回格式不符合预期', 'AI_INVALID_RESPONSE');
    return { content: JSON.stringify(json), providerStatus: response.providerStatus, durationMs: response.durationMs };
  }

  async reviewStandardNodes(nodes, context = {}) {
    if (!this.enabled) throw aiError('AI服务未配置或未启用', 'AI_CONFIG_ERROR');
    const response = await this.request([
      {
        role: 'system',
        content: [
          '你是标准规范导入复核助手。只对给定条款提供复核建议，不直接修改业务数据。',
          '结合OCR正文、对照正文和条款编号判断：',
          '1. comparisonContent可靠且与OCR表达同一条款时，建议 adopt_comparison；',
          '2. 仅存在明确OCR错字、断字或标点错误时，建议 correct_ocr，并给出修正后的完整正文；',
          '3. OCR疑似把多个字母条款拼接在一起、漏掉正文或编号冲突时，建议 split_required 或 uncertain，不要猜测补写；',
          '4. 无法确认时建议 keep_ocr；不能决定章节层级，也不能判定业务满足情况；',
          '5. 只返回JSON：{"suggestions":[{"nodeId":"...","action":"adopt_comparison|correct_ocr|keep_ocr|split_required|uncertain","confidence":0到1,"content":"完整正文或原文","reason":"不超过120字","issues":["..."]}]}。',
          '6. 每个节点必须返回一条建议，content 必须是该节点当前完整正文，不得总结或扩写。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          context: {
            standardCode: context.standardCode || '',
            standardName: context.standardName || '',
            version: context.version || '',
          },
          nodes: nodes.map(node => ({
            nodeId: node.id,
            originalNumber: node.originalNumber,
            title: node.title || '',
            ocrContent: node.ocrContent || node.content || '',
            comparisonContent: node.comparisonContent || '',
            comparisonItemCode: node.comparisonItemCode || '',
            comparisonMatch: node.comparisonMatch || '',
            comparisonMarkerConflict: Boolean(node.comparisonMarkerConflict),
          })),
        }),
      },
    ]);
    let suggestions;
    try {
      suggestions = parseStandardReviewSuggestions(response.content, new Map(nodes.map(node => [ node.id, node ])));
    } catch {
      throw aiError('AI返回的复核结果格式无效', 'AI_INVALID_RESPONSE');
    }
    return {
      suggestions,
      providerStatus: response.providerStatus,
      durationMs: response.durationMs,
    };
  }
}

function parseJsonContent(content) {
  if (!content) throw new Error('AI 返回内容为空');
  return JSON.parse(String(content).replace(/^```json\s*/i, '').replace(/\s*```$/, ''));
}

function parseStandardReviewSuggestions(content, sourceById) {
  const json = parseJsonContent(content);
  if (!Array.isArray(json.suggestions)) throw new Error('AI suggestions 格式无效');
  const actions = new Set([ 'adopt_comparison', 'correct_ocr', 'keep_ocr', 'split_required', 'uncertain' ]);
  const result = [];
  for (const item of json.suggestions) {
    const nodeId = String(item?.nodeId || '').trim();
    const source = sourceById.get(nodeId);
    if (!source || !actions.has(item?.action)) continue;
    const confidence = Number(item.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    const contentValue = String(item.content ?? source.content ?? '').trim();
    if (!contentValue || contentValue.length > 20000) continue;
    result.push({
      nodeId,
      action: item.action,
      confidence,
      content: contentValue,
      reason: String(item.reason || '').trim().slice(0, 500),
      issues: Array.isArray(item.issues) ? item.issues.map(String).slice(0, 10) : [],
    });
  }
  return result;
}

function parseAiResult(content) {
  if (!content) throw new Error('AI 返回内容为空');
  const json = JSON.parse(String(content).replace(/^```json\s*/i, '').replace(/\s*```$/, ''));
  const relations = new Set([ 'duplicate', 'similar_but_distinct', 'unrelated', 'uncertain' ]);
  if (!relations.has(json.relation)) throw new Error('AI relation 无效');
  const confidence = Number(json.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('AI confidence 无效');
  return {
    relation: json.relation,
    confidence,
    differences: Array.isArray(json.differences) ? json.differences.map(String) : [],
    reason: String(json.reason || ''),
    recommendedCanonicalId: json.recommendedCanonicalId || null,
  };
}

module.exports = {
  AiProvider,
  friendlyAiError,
  parseAiResult,
  parseStandardReviewSuggestions,
};
