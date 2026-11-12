'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chapterStandardNumber, itemStandardNumber, numberPrefix } = require('../app/lib/standardNumber');

test('builds stable standard numbers from the standard code, chapter, and import order', () => {
  assert.equal(numberPrefix('GB/T 31168'), '31168');
  assert.equal(chapterStandardNumber('GB/T 31168', '6.1'), '31168-6.1');
  assert.equal(itemStandardNumber('GB/T 31168', '6.1', 1), '31168-6.1-0001');
  assert.equal(itemStandardNumber('GB/T 31168', '6.1', 12), '31168-6.1-0012');
});
