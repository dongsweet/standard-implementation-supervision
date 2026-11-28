'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPaginationItems } = require('../app/lib/pagination');

test('keeps short pagination complete', () => {
  assert.deepEqual(buildPaginationItems(1, 1), [ 1 ]);
  assert.deepEqual(buildPaginationItems(3, 7), [ 1, 2, 3, 4, 5, 6, 7 ]);
});

test('condenses long pagination around the current page', () => {
  assert.deepEqual(buildPaginationItems(1, 49), [ 1, 2, 3, 'ellipsis-49', 49 ]);
  assert.deepEqual(buildPaginationItems(25, 49), [
    1, 'ellipsis-23', 23, 24, 25, 26, 27, 'ellipsis-49', 49,
  ]);
  assert.deepEqual(buildPaginationItems(49, 49), [ 1, 'ellipsis-47', 47, 48, 49 ]);
});
