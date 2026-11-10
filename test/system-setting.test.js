'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decryptSecret, encryptSecret } = require('../app/lib/secretBox');

test('encrypts API keys with authenticated encryption and never returns plaintext', () => {
  const encrypted = encryptSecret('sk-example-secret', 'test-signing-key');
  assert.notEqual(encrypted, 'sk-example-secret');
  assert.equal(encrypted.startsWith('v1:'), true);
  assert.equal(encrypted.includes('sk-example-secret'), false);
  assert.equal(decryptSecret(encrypted, 'test-signing-key'), 'sk-example-secret');
  assert.throws(() => decryptSecret(encrypted, 'wrong-key'));
});
