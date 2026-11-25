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
      if (!error.aiCode && /fetch failed/i.test(error.message || '')) {
        error.aiCode = error.cause?.code || 'AI_NETWORK_ERROR';
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async classifyPair(left, right) {
    if (!this.enabled) return { result: { relation: 'uncertain', confidence: 0, differences: [], reason: 'AI 服务未配置', recommendedCanonicalId: null }, providerStatus: null, durationMs: 0 };
    const response = await this.request([
      { role: 'system', content: '你是监督检查定义去重助手。只判断语义是否等价，不修改数据。检查对象必须相同才可建议 duplicate；适用检查中心列表属于方案适用范围元数据，中心不同不代表检查定义不同，也不得单独作为不重复理由。必须返回 JSON：relation、confidence、differences、reason、recommendedCanonicalId。' },
      { role: 'user', content: JSON.stringify({ left, right }) },
    ]);
    return { result: parseAiResult(response.content), providerStatus: response.providerStatus, durationMs: response.durationMs };
  }

  async classifyCenterObjectPair({ centerName, left, right }) {
    if (!this.enabled) {
      return {
        result: {
          relation: 'uncertain',
          confidence: 0,
          differences: [],
          reason: 'AI 服务未配置',
          recommendedCanonicalName: null,
        },
        providerStatus: null,
        durationMs: 0,
      };
    }
    const response = await this.request([
      {
        role: 'system',
        content: [
          '你是检查中心“检查对象”去重助手。只判断两个对象名称是否表示同一个可检查对象，不修改数据。',
          '必须结合对象名称、关联检查方案的方法、描述、步骤、频率和执行方式判断；不能只看字面相似。',
      '“对内发布/对外发布”“更换记录/盘点记录”等方向、用途或管理动作不同的对象，不算重复。',
          '如果只是同一类检查应用到不同设备或不同对象，必须判为 similar_but_distinct；如果只是名称包含附加材料或列表，必须判为 similar_but_distinct。',
          'relation 只能是 duplicate、similar_but_distinct、unrelated、uncertain。',
          'recommendedCanonicalName 必须是 left.name 或 right.name；不确定时为 null。',
          '只返回 JSON：{"relation":"duplicate|similar_but_distinct|unrelated|uncertain","confidence":0到1,"differences":["..."],"reason":"不超过120字","recommendedCanonicalName":"左侧或右侧对象名称或null"}。',
        ].join('\n'),
      },
      { role: 'user', content: JSON.stringify({ centerName, left, right }) },
    ]);
    const result = parseObjectAiResult(response.content);
    return { result, providerStatus: response.providerStatus, durationMs: response.durationMs };
  }

  async classifyDefinitionPairs(items) {
    if (!this.enabled) {
      return {
        results: items.map(item => ({
          id: item.id,
          relation: 'uncertain',
          confidence: 0,
          differences: [],
          reason: 'AI 服务未配置',
          recommendedCanonicalId: null,
        })),
        providerStatus: null,
        durationMs: 0,
      };
    }
    if (!Array.isArray(items) || !items.length) return { results: [], providerStatus: null, durationMs: 0 };
    const response = await this.request([
      {
        role: 'system',
        content: [
          '你是监督检查方案去重助手。一次会给你一组方案候选对，请逐对判断两条检查方案是否语义等价，不修改数据。',
          '只有检查对象、检查内容和执行要求实质相同才可判为 duplicate；检查对象不同、用途或方向不同、步骤存在实质差异时必须判为 similar_but_distinct。',
          '适用检查中心属于适用范围，不应单独作为不重复理由；但检查对象名称必须相同。',
          'relation 只能是 duplicate、similar_but_distinct、unrelated、uncertain。',
          'recommendedCanonicalId 必须是该对的 left.id 或 right.id；不确定时为 null。',
          '必须为每个输入 id 返回一条结果，不得遗漏或新增 id。',
          '只返回 JSON：{"results":[{"id":"输入id","relation":"duplicate|similar_but_distinct|unrelated|uncertain","confidence":0到1,"differences":["..."],"reason":"不超过120字","recommendedCanonicalId":"left.id或right.id或null"}]}。',
        ].join('\n'),
      },
      { role: 'user', content: JSON.stringify({ items }) },
    ]);
    const results = parseDefinitionAiResults(response.content, items);
    return { results, providerStatus: response.providerStatus, durationMs: response.durationMs };
  }

  async classifyCenterObjectPairs(items) {
    if (!this.enabled) {
      return {
        results: items.map(item => ({
          id: item.id,
          relation: 'uncertain',
          confidence: 0,
          differences: [],
          reason: 'AI 服务未配置',
          recommendedCanonicalName: null,
        })),
        providerStatus: null,
        durationMs: 0,
      };
    }
    if (!Array.isArray(items) || !items.length) return { results: [], providerStatus: null, durationMs: 0 };
    const response = await this.request([
      {
        role: 'system',
        content: [
          '你是检查中心“检查对象”去重助手。一次会给你一组候选对，请逐对判断两个对象名称是否表示同一个可检查对象，不修改数据。',
          '必须结合对象名称、关联检查方案的方法、描述、步骤、频率和执行方式判断；不能只看字面相似。',
          '“对内发布/对外发布”“更换记录/盘点记录”等方向、用途或管理动作不同的对象，不算重复。',
          '如果只是同一类检查应用到不同设备或不同对象，必须判为 similar_but_distinct；如果只是名称包含附加材料或列表，必须判为 similar_but_distinct。',
          'relation 只能是 duplicate、similar_but_distinct、unrelated、uncertain。',
          'recommendedCanonicalName 必须是该对的 left.name 或 right.name；不确定时为 null。',
          '必须为每个输入 id 返回一条结果，不得遗漏或新增 id。',
          '只返回 JSON：{"results":[{"id":"输入id","relation":"duplicate|similar_but_distinct|unrelated|uncertain","confidence":0到1,"differences":["..."],"reason":"不超过120字","recommendedCanonicalName":"名称或null"}]}。',
        ].join('\n'),
      },
      { role: 'user', content: JSON.stringify({ items }) },
    ]);
    const results = parseObjectAiResults(response.content, items);
    return { results, providerStatus: response.providerStatus, durationMs: response.durationMs };
  }

  async reviewJointIssue(context) {
    if (!this.enabled) throw aiError('AI服务未配置或未启用', 'AI_CONFIG_ERROR');
    const response = await this.request([
      {
        role: 'system',
        content: [
          '你是规范、项目应答与持续监督联合复核助手。只提供判断建议，不能修改标准、项目应答、检查方案或规范对象。',
          '结合检查对象、对象分类、标准正文、项目应答赋值、检查描述、步骤、频率和执行方式判断。',
          '“对象 + 制度/记录/报告/文档”可能是合理关系，不能仅凭名称判定错误。',
          'verdict 只能是 possible_match、possible_mismatch、insufficient_information、multiple_objects。',
          '重点判断：对象与内容是否匹配；方案与标准项是否讲同一要求；标准/应答/方案频率是否一致；项目适用项是否被方案覆盖；对象分类是否混入证据材料。',
          '只返回 JSON：{"verdict":"possible_match|possible_mismatch|insufficient_information|multiple_objects","confidence":0到1,"severity":"error|warning|info","summary":"不超过120字","evidence":["..."],"suggestedActions":["..."],"reason":"不超过240字"}。',
        ].join('\n'),
      },
      { role: 'user', content: JSON.stringify(context) },
    ]);
    return {
      result: parseJointReviewResult(response.content),
      providerStatus: response.providerStatus,
      durationMs: response.durationMs,
    };
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

function parseObjectAiResult(content) {
  if (!content) throw new Error('AI 返回内容为空');
  const json = JSON.parse(String(content).replace(/^```json\s*/i, '').replace(/\s*```$/, ''));
  const relations = new Set([ 'duplicate', 'similar_but_distinct', 'unrelated', 'uncertain' ]);
  if (!relations.has(json.relation)) throw new Error('AI relation 无效');
  const confidence = Number(json.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('AI confidence 无效');
  return {
    relation: json.relation,
    confidence,
    differences: Array.isArray(json.differences) ? json.differences.map(String).slice(0, 20) : [],
    reason: String(json.reason || '').slice(0, 500),
    recommendedCanonicalName: json.recommendedCanonicalName
      ? String(json.recommendedCanonicalName)
      : null,
  };
}

function parseDefinitionAiResults(content, items) {
  if (!content) throw new Error('AI 返回内容为空');
  const json = JSON.parse(String(content).replace(/^```json\s*/i, '').replace(/\s*```$/, ''));
  const rawResults = Array.isArray(json) ? json : json.results;
  if (!Array.isArray(rawResults)) throw new Error('AI 批量结果缺少 results 数组');
  const itemById = new Map(items.map(item => [ String(item.id), item ]));
  const relations = new Set([ 'duplicate', 'similar_but_distinct', 'unrelated', 'uncertain' ]);
  const seen = new Set();
  const results = [];
  for (const raw of rawResults) {
    const id = String(raw?.id || '');
    const item = itemById.get(id);
    if (!item || seen.has(id) || !relations.has(raw.relation)) continue;
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    const recommendedCanonicalId = raw.recommendedCanonicalId
      ? String(raw.recommendedCanonicalId)
      : null;
    results.push({
      id,
      relation: raw.relation,
      confidence,
      differences: Array.isArray(raw.differences) ? raw.differences.map(String).slice(0, 20) : [],
      reason: String(raw.reason || '').slice(0, 500),
      recommendedCanonicalId: [ item.left?.id, item.right?.id ].includes(recommendedCanonicalId)
        ? recommendedCanonicalId
        : null,
    });
    seen.add(id);
  }
  if (!results.length) throw new Error('AI 批量结果没有有效方案判断');
  return results;
}

function parseObjectAiResults(content, items) {
  if (!content) throw new Error('AI 返回内容为空');
  const json = JSON.parse(String(content).replace(/^```json\s*/i, '').replace(/\s*```$/, ''));
  const rawResults = Array.isArray(json) ? json : json.results;
  if (!Array.isArray(rawResults)) throw new Error('AI 批量结果缺少 results 数组');
  const itemById = new Map(items.map(item => [ String(item.id), item ]));
  const seen = new Set();
  const results = [];
  for (const raw of rawResults) {
    const id = String(raw?.id || '');
    const item = itemById.get(id);
    if (!item || seen.has(id)) continue;
    const relationSet = new Set([ 'duplicate', 'similar_but_distinct', 'unrelated', 'uncertain' ]);
    if (!relationSet.has(raw.relation)) continue;
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    const recommended = raw.recommendedCanonicalName
      ? String(raw.recommendedCanonicalName)
      : null;
    results.push({
      id,
      relation: raw.relation,
      confidence,
      differences: Array.isArray(raw.differences) ? raw.differences.map(String).slice(0, 20) : [],
      reason: String(raw.reason || '').slice(0, 500),
      recommendedCanonicalName: [ item.left?.name, item.right?.name ].includes(recommended)
        ? recommended
        : null,
    });
    seen.add(id);
  }
  if (!results.length) throw new Error('AI 批量结果没有有效对象判断');
  return results;
}

function parseJointReviewResult(content) {
  if (!content) throw new Error('AI 返回内容为空');
  const json = JSON.parse(String(content).replace(/^```json\s*/i, '').replace(/\s*```$/, ''));
  const verdicts = new Set([ 'possible_match', 'possible_mismatch', 'insufficient_information', 'multiple_objects' ]);
  if (!verdicts.has(json.verdict)) throw new Error('AI verdict 无效');
  const confidence = Number(json.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('AI confidence 无效');
  const severity = [ 'error', 'warning', 'info' ].includes(json.severity) ? json.severity : 'warning';
  return {
    verdict: json.verdict,
    confidence,
    severity,
    summary: String(json.summary || '').slice(0, 500),
    evidence: Array.isArray(json.evidence) ? json.evidence.map(String).slice(0, 20) : [],
    suggestedActions: Array.isArray(json.suggestedActions) ? json.suggestedActions.map(String).slice(0, 20) : [],
    reason: String(json.reason || '').slice(0, 1000),
  };
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
  parseDefinitionAiResults,
  parseJointReviewResult,
  parseObjectAiResult,
  parseObjectAiResults,
  parseStandardReviewSuggestions,
};
