'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ProjectRepository = require('../app/repository/project');

function createRepository({ projectExists = true, versionExists = true } = {}) {
  const queries = [];
  let released = false;
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      queries.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: null };
      if (statement === 'SELECT id FROM projects WHERE id = $1 FOR UPDATE') {
        return { rows: projectExists ? [ { id: 'project-1' } ] : [], rowCount: projectExists ? 1 : 0 };
      }
      if (statement.startsWith('SELECT sv.id FROM standard_versions sv')) {
        return { rows: versionExists ? [ { id: 'version-1' } ] : [], rowCount: versionExists ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {
      released = true;
    },
  };
  return {
    repository: new ProjectRepository({ connect: async () => client }),
    queries,
    isReleased: () => released,
  };
}

test('adds a standard version and snapshots all of its items in one transaction', async () => {
  const { repository, queries, isReleased } = createRepository();
  await repository.addProjectStandardVersion({ projectId: 'project-1', standardVersionId: 'version-1' });

  assert.ok(queries.some(query => query.statement === 'COMMIT'));
  const versionInsert = queries.find(query => query.statement.startsWith('INSERT INTO project_standard_versions '));
  assert.deepEqual(versionInsert.values, [ 'project-1', 'version-1' ]);
  const snapshotInsert = queries.find(query => query.statement.startsWith('INSERT INTO project_standard_items '));
  assert.match(snapshotInsert.statement, /SELECT \$1, si\.id, si\.standard_number, si\.item_code, si\.content, sc\.code, now\(\)/);
  assert.match(snapshotInsert.statement, /WHERE si\.standard_version_id = \$2/);
  assert.deepEqual(snapshotInsert.values, [ 'project-1', 'version-1' ]);
  assert.equal(isReleased(), true);
});

test('rejects a version without standard items and rolls back', async () => {
  const { repository, queries, isReleased } = createRepository({ versionExists: false });
  await assert.rejects(
    repository.addProjectStandardVersion({ projectId: 'project-1', standardVersionId: 'version-empty' }),
    error => error.code === 'INVALID_STANDARD_VERSION'
  );
  assert.ok(queries.some(query => query.statement === 'ROLLBACK'));
  assert.equal(queries.some(query => query.statement === 'COMMIT'), false);
  assert.equal(isReleased(), true);
});
