'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AiProvider, friendlyAiError, parseObjectAiResult, parseObjectAiResults } = require('../app/lib/aiProvider');
let AiProviderService;
try {
  AiProviderService = require('../app/service/aiProvider');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function createServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('maps network, authentication, endpoint, and rate-limit errors to actionable messages', () => {
  const timeout = new Error('fetch failed');
  timeout.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
  assert.deepEqual(friendlyAiError(timeout, 'https://ai.example.com/v1'), {
    statusCode: 504,
    code: 'AI_CONNECT_TIMEOUT',
    message: '连接AI服务 ai.example.com 超时，请检查服务地址、网络访问和防火墙。',
  });
  assert.equal(friendlyAiError({ providerStatus: 401 }, 'https://ai.example.com').code, 'AI_AUTH_ERROR');
  assert.equal(friendlyAiError({ providerStatus: 404 }, 'https://ai.example.com').code, 'AI_ENDPOINT_NOT_FOUND');
  assert.equal(friendlyAiError({ providerStatus: 429 }, 'https://ai.example.com').code, 'AI_RATE_LIMIT');
  const refused = new Error('fetch failed');
  refused.aiCode = 'ECONNREFUSED';
  assert.equal(friendlyAiError(refused, 'https://ai.example.com').code, 'ECONNREFUSED');
});

test('validates center object semantic dedupe responses', () => {
  const result = parseObjectAiResult(JSON.stringify({
    relation: 'duplicate',
    confidence: 0.93,
    differences: [ '名称包含书名号' ],
    reason: '两个名称指向同一检查对象。',
    recommendedCanonicalName: '采购合同或协议',
  }));
  assert.equal(result.relation, 'duplicate');
  assert.equal(result.confidence, 0.93);
  assert.equal(result.recommendedCanonicalName, '采购合同或协议');
  assert.throws(
    () => parseObjectAiResult(JSON.stringify({ relation: 'merge_now', confidence: 1 })),
    /relation 无效/
  );
});

test('validates and aligns batched center object AI results by candidate id', () => {
  const items = [
    { id: 'pair-a', left: { name: '安全信息对内发布记录' }, right: { name: '安全信息对外发布记录' } },
    { id: 'pair-b', left: { name: '《采购合同或协议》' }, right: { name: '采购合同或协议' } },
  ];
  const results = parseObjectAiResults(JSON.stringify({
    results: [
      { id: 'pair-b', relation: 'duplicate', confidence: 0.98, reason: '同一对象', recommendedCanonicalName: '采购合同或协议' },
      { id: 'pair-a', relation: 'similar_but_distinct', confidence: 0.97, reason: '方向不同', recommendedCanonicalName: '不存在' },
    ],
  }), items);
  assert.equal(results.length, 2);
  assert.equal(results[0].id, 'pair-b');
  assert.equal(results[0].recommendedCanonicalName, '采购合同或协议');
  assert.equal(results[1].relation, 'similar_but_distinct');
  assert.equal(results[1].recommendedCanonicalName, null);
  assert.throws(
    () => parseObjectAiResults(JSON.stringify({ results: [] }), items),
    /没有有效对象判断/
  );
});

test('submits a center object AI batch in one model request', async () => {
  const requests = [];
  const server = await createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        choices: [ {
          message: {
            content: JSON.stringify({
              results: payload.messages[1].content
                ? JSON.parse(payload.messages[1].content).items.map(item => ({
                  id: item.id,
                  relation: 'similar_but_distinct',
                  confidence: 0.9,
                  differences: [ '方向不同' ],
                  reason: '测试批处理',
                  recommendedCanonicalName: null,
                }))
                : [],
            }),
          },
        } ],
      }));
    });
  });
  try {
    const address = server.address();
    const provider = new AiProvider({
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test-key',
      model: 'test-model',
      timeoutMs: 5000,
    });
    const items = [
      { id: 'a', left: { name: '对内发布' }, right: { name: '对外发布' } },
      { id: 'b', left: { name: '更换记录' }, right: { name: '盘点记录' } },
    ];
    const result = await provider.classifyCenterObjectPairs(items);
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0].messages[1].content).items.length, 2);
    assert.deepEqual(result.results.map(item => item.id), [ 'a', 'b' ]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('exposes center object semantic review through the Egg AI service', { skip: !AiProviderService }, async () => {
  const original = AiProviderService.prototype.getProvider;
  let received;
  AiProviderService.prototype.getProvider = async function getProvider() {
    return {
      async classifyCenterObjectPair(payload) {
        received = payload;
        return { result: { relation: 'duplicate', confidence: 0.9 } };
      },
      async classifyCenterObjectPairs(items) {
        received = items;
        return { results: items.map(item => ({ id: item.id, relation: 'uncertain', confidence: 0.5 })) };
      },
    };
  };
  try {
    const context = {
      getProvider: AiProviderService.prototype.getProvider,
      ctx: {
        service: {
          systemSetting: { getAiConfig: async () => ({ enabled: true, baseUrl: 'https://example.com', apiKey: 'key', model: 'model' }) },
        },
      },
    };
    const result = await AiProviderService.prototype.classifyCenterObjectPair.call(
      context,
      { centerName: '总部', left: {}, right: {} }
    );
    assert.equal(result.result.relation, 'duplicate');
    assert.equal(received.centerName, '总部');
    const batch = await AiProviderService.prototype.classifyCenterObjectPairs.call(
      context,
      [ { id: 'a' }, { id: 'b' } ]
    );
    assert.deepEqual(batch.results.map(item => item.id), [ 'a', 'b' ]);
  } finally {
    AiProviderService.prototype.getProvider = original;
  }
});

test('tests an OpenAI-compatible endpoint and validates smart review suggestions', async () => {
  const requests = [];
  const server = await createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ data: JSON.parse(body), authorization: request.headers.authorization });
      const requestBody = JSON.parse(body);
      const isTest = requestBody.messages?.[1]?.content === '请返回 {"status":"ok"}。';
      const isSmartReview = requestBody.messages?.[0]?.content?.includes('标准规范导入复核助手');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify(isTest ? { status: 'ok' } : isSmartReview ? {
              suggestions: [{
                nodeId: 'n1',
                action: 'adopt_comparison',
                confidence: 0.94,
                content: '对照正文',
                reason: '对照正文与OCR正文属于同一条款',
              }],
            } : { status: 'ok' }),
          },
        }],
      }));
    });
  });
  try {
    const address = server.address();
    const provider = new AiProvider({
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test-key',
      model: 'test-model',
      timeoutMs: 5000,
    });
    const connection = await provider.testConnection();
    assert.equal(connection.content, '{"status":"ok"}');
    const review = await provider.reviewStandardNodes([{
      id: 'n1',
      originalNumber: '6.1.1 a)',
      title: '',
      content: '当前正文',
      comparisonContent: '对照正文',
      comparisonItemCode: '6001',
    }], { standardCode: 'GB/T 31168', version: '2023' });
    assert.equal(review.suggestions[0].action, 'adopt_comparison');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].authorization, 'Bearer test-key');
    assert.equal(requests[0].data.model, 'test-model');
    assert.equal(requests[1].data.max_tokens, 2000);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
