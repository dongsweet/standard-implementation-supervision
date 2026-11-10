'use strict';

const crypto = require('node:crypto');

function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest();
}

function encryptSecret(value, secret) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const encrypted = Buffer.concat([ cipher.update(String(value), 'utf8'), cipher.final() ]);
  const tag = cipher.getAuthTag();
  return [ 'v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url') ].join(':');
}

function decryptSecret(value, secret) {
  if (!value) return '';
  const [ version, iv, tag, encrypted ] = String(value).split(':');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('无效的加密配置');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([ decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final() ]).toString('utf8');
}

module.exports = { decryptSecret, encryptSecret };
