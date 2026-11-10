'use strict';

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
      throw new Error('生产环境的AI接口必须使用HTTPS；内网HTTP地址仅允许localhost回环地址');
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
        const error = new Error(`AI HTTP ${response.status}${detail ? ': ' + detail : ''}`);
        error.providerStatus = response.status;
        throw error;
      }
      const body = await response.json();
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('AI 返回内容为空');
      return {
        content,
        providerStatus: response.status,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      error.durationMs = Date.now() - startedAt;
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
    if (!this.enabled) throw new Error('AI 服务未完整配置');
    const response = await this.request([
      { role: 'system', content: '只返回 JSON，不要附加说明。' },
      { role: 'user', content: '请返回 {"status":"ok"}。' },
    ]);
    let json;
    try {
      json = parseJsonContent(response.content);
    } catch {
      throw new Error('AI 返回的不是有效JSON');
    }
    if (json.status !== 'ok') throw new Error('AI 返回格式不符合预期');
    return { content: JSON.stringify(json), providerStatus: response.providerStatus, durationMs: response.durationMs };
  }

  async correctStandardNodes(nodes, context = {}) {
    if (!this.enabled) throw new Error('AI 服务未配置或未启用');
    const response = await this.request([
      {
        role: 'system',
        content: [
          '你是标准文档OCR校对助手。任务只是修正明显的文字识别错误，不是改写标准。',
          '严格规则：',
          '1. 保持原意、编号体系和条款完整性，禁止总结、扩写、删减或语义润色。',
          '2. 只修正明显OCR错误：错字、漏空格、全角/半角标点、跨行断字和可确认的形近字。',
          '3. 无法确认的内容必须保持原样，不得猜测或补写缺失文本。',
          '4. 原文编号原则上保持不变；只有明显OCR噪声且上下文能唯一确认时才修正。',
          '5. 必须返回JSON：{"corrections":[{"nodeId":"...","originalNumber":"...","title":"...","content":"...","confidence":0到1,"reason":"不超过80字"}]}。',
          '6. 只返回确实需要修改的节点；没有把握返回空数组。',
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
            content: node.content || '',
          })),
        }),
      },
    ]);
    return {
      corrections: parseStandardCorrections(response.content, new Set(nodes.map(node => node.id))),
      providerStatus: response.providerStatus,
      durationMs: response.durationMs,
    };
  }
}

function parseJsonContent(content) {
  if (!content) throw new Error('AI 返回内容为空');
  return JSON.parse(String(content).replace(/^```json\s*/i, '').replace(/\s*```$/, ''));
}

function parseStandardCorrections(content, validNodeIds) {
  const json = parseJsonContent(content);
  if (!Array.isArray(json.corrections)) throw new Error('AI corrections 格式无效');
  const result = [];
  for (const item of json.corrections) {
    const nodeId = String(item?.nodeId || '').trim();
    if (!validNodeIds.has(nodeId)) continue;
    const originalNumber = String(item.originalNumber || '').trim();
    const title = String(item.title || '').trim();
    const correctedContent = String(item.content || '').trim();
    const confidence = Number(item.confidence);
    if (!originalNumber || originalNumber.length > 100 || title.length > 500 || !correctedContent) continue;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    result.push({
      nodeId,
      originalNumber,
      title,
      content: correctedContent,
      confidence,
      reason: String(item.reason || '').trim().slice(0, 500),
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

module.exports = { AiProvider, parseAiResult, parseStandardCorrections };
