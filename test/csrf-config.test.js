'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const configFactory = require('../config/config.default');

test('CSRF accepts the same-origin referer for multipart uploads', () => {
  const config = configFactory({ name: 'test-app', baseDir: process.cwd() });
  assert.deepEqual(config.security.csrf, { enable: true, type: 'any' });
});

test('allows a PDF and a comparison workbook in one multipart request', () => {
  const config = configFactory({ name: 'test-app', baseDir: process.cwd() });
  assert.equal(config.multipart.mode, 'file');
  assert.equal(config.multipart.fileSize, '50mb');
  assert.equal(config.multipart.fieldSize, '1mb');
  assert.equal(config.multipart.fields, 20);
  assert.equal(config.multipart.fileExtensions.includes('.pdf'), true);
  assert.equal(config.multipart.fileExtensions.includes('.xlsx'), true);
  assert.equal(config.bodyParser.jsonLimit, '8mb');
});
