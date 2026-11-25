'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Repository = require('../app/repository/supervisionDefinition');

test('lists each active category with its canonical objects for the maintenance table', async () => {
  let captured;
  const repository = new Repository({
    async query(sql) {
      captured = sql.replace(/\s+/g, ' ').trim();
      return {
        rows: [ {
          id: 'category-1',
          name: '业务平台',
          description: '业务系统',
          object_count: 2,
          objects: [
            { id: 'object-1', name: '云平台' },
            { id: 'object-2', name: '业务防火墙' },
          ],
        } ],
        rowCount: 1,
      };
    },
  });
  const categories = await repository.listObjectCategories();
  assert.equal(categories[0].object_count, 2);
  assert.deepEqual(categories[0].objects.map(item => item.name), [ '云平台', '业务防火墙' ]);
  assert.match(captured, /jsonb_agg\(DISTINCT jsonb_build_object\('id', o\.id, 'name', o\.canonical_name\)\)/);
  assert.match(captured, /FILTER \(WHERE o\.id IS NOT NULL\)/);
  assert.match(captured, /AS objects/);
});
