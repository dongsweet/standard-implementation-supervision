'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AiProvider, friendlyAiError } = require('../app/lib/aiProvider');

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
});

test('tests an OpenAI-compatible endpoint and validates standard correction suggestions', async () => {
  const requests = [];
  const server = await createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ data: JSON.parse(body), authorization: request.headers.authorization });
      const isTest = JSON.parse(body).messages?.[1]?.content === '请返回 {"status":"ok"}。';
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify(isTest ? { status: 'ok' } : {
              corrections: [{
                nodeId: 'n1',
                originalNumber: '6.1.1 a)',
                title: '',
                content: '对保护信息系统和服务所需的资源进行详细分析。',
                confidence: 0.95,
                reason: '修正跨行空格',
              }],
            }),
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
    const result = await provider.correctStandardNodes([{
      id: 'n1',
      originalNumber: '6.1.1 a)',
      title: '',
      content: '对保护信息系统和服务所需的资源进行详细分析。',
    }], { standardCode: 'GB/T 31168', version: '2023' });
    assert.equal(result.corrections.length, 1);
    assert.equal(result.corrections[0].nodeId, 'n1');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].authorization, 'Bearer test-key');
    assert.equal(requests[0].data.model, 'test-model');
    assert.equal(requests[1].data.max_tokens, 2000);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
