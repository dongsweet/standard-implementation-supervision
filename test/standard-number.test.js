'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chapterStandardNumber, itemStandardNumber, numberPrefix } = require('../app/lib/standardNumber');

test('builds stable standard numbers from standard, version, chapter root, and order', () => {
  assert.equal(numberPrefix('GB/T 31168'), '31168');
  assert.equal(chapterStandardNumber('GB/T 31168', '2023', '6.1'), '31168-2023-06');
  assert.equal(itemStandardNumber('GB/T 31168', '2023', '6.1', 1), '31168-2023-06001');
  assert.equal(itemStandardNumber('GB/T 31168', '2023', '6.1', 12), '31168-2023-06012');
});
