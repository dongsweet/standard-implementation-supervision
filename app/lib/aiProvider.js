'use strict';

class AiProvider {
  constructor(config) {
    this.config = config;
  }

  get enabled() {
    return Boolean(this.config.baseUrl && this.config.apiKey && this.config.model);
  }

  async classifyPair(left, right) {
    if (!this.enabled) return { relation: 'uncertain', confidence: 0, differences: [], reason: 'AI 服务未配置' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: '你是监督检查定义去重助手。只判断语义是否等价，不修改数据。必须返回 JSON：relation、confidence、differences、reason、recommendedCanonicalId。' },
            { role: 'user', content: JSON.stringify({ left, right }) },
          ],
        }),
      });
      if (!response.ok) throw new Error(`AI HTTP ${response.status}`);
      const body = await response.json();
      return parseAiResult(body.choices?.[0]?.message?.content);
    } finally {
      clearTimeout(timer);
    }
  }
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

module.exports = { AiProvider, parseAiResult };
