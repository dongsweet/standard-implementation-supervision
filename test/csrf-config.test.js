'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const configFactory = require('../config/config.default');

test('CSRF accepts the same-origin referer for multipart uploads', () => {
  const config = configFactory({ name: 'test-app', baseDir: process.cwd() });
  assert.deepEqual(config.security.csrf, { enable: true, type: 'any' });
});
