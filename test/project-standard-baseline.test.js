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
  assert.match(snapshotInsert.statement, /SELECT \$1, si\.id, si\.standard_number, si\.item_code, COALESCE\(si\.explanation, parent\.explanation\), si\.content, sc\.code, si\.heading_path, now\(\)/);
  assert.match(snapshotInsert.statement, /WHERE si\.standard_version_id = \$2/);
  assert.deepEqual(snapshotInsert.values, [ 'project-1', 'version-1', '\\s+[a-z]\\s*[)）)_]\\s*$', '' ]);
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

test('backfills only missing explanatory parent items from a project standard version', async () => {
  let captured;
  const repository = new ProjectRepository({
    async query(sql, values) {
      captured = { sql: sql.replace(/\s+/g, ' ').trim(), values };
      return { rowCount: 2, rows: [ { standard_item_id: 'note-1' }, { standard_item_id: 'note-2' } ] };
    },
  });
  const inserted = await repository.ensureProjectExplanationItems('project-1', 'version-1');
  assert.equal(inserted, 2);
  assert.deepEqual(captured.values, [ 'project-1', 'version-1' ]);
  assert.match(captured.sql, /NULLIF\(btrim\(si\.explanation\), ''\) IS NOT NULL/);
  assert.match(captured.sql, /si\.content ~ '\(赋值\|选择\)\[：:\]'/);
  assert.match(captured.sql, /FROM standard_items child/);
  assert.match(captured.sql, /child\.standard_version_id = si\.standard_version_id/);
  assert.match(captured.sql, /child\.item_code/);
  assert.doesNotMatch(captured.sql, /child\.item_code_snapshot/);
  assert.match(captured.sql, /ON CONFLICT \(project_id, standard_item_id\) DO NOTHING/);
});

test('lists project baseline standards for the chapter answer overview', async () => {
  const queries = [];
  const repository = new ProjectRepository({
    async query(sql, values) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
      if (queries.length === 1) return { rowCount: 1, rows: [ { id: 'project-1', name: '多云统管' } ] };
      return { rowCount: 1, rows: [ { standard_version_id: 'version-1', item_count: 526, answered_count: 12 } ] };
    },
  });
  const result = await repository.getProjectAnswerOverview('project-1');
  assert.equal(result.project.name, '多云统管');
  assert.equal(result.standards[0].standard_version_id, 'version-1');
  assert.ok(queries.some(query => /LEFT JOIN project_standard_answers/.test(query.sql)));
  const explanationBackfill = queries.find(query => query.sql.startsWith('INSERT INTO project_standard_items'));
  assert.match(explanationBackfill.sql, /NULLIF\(btrim\(si\.explanation\), ''\) IS NOT NULL/);
  assert.match(explanationBackfill.sql, /FROM standard_items child/);
  assert.match(explanationBackfill.sql, /child\.standard_version_id = si\.standard_version_id/);
  assert.deepEqual(queries[0].values, [ 'project-1' ]);
});

test('filters, sorts, and paginates project standard answers', async () => {
  const queries = [];
  const repository = new ProjectRepository({
    async query(sql, values) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      queries.push({ statement, values });
      if (statement.includes('FROM project_standard_versions psv')) return { rowCount: 1, rows: [ { standard_version_id: 'version-1', project_name: '多云统管' } ] };
      if (statement.startsWith('SELECT DISTINCT psi.chapter_code_snapshot')) return { rowCount: 1, rows: [ { code: '6', name: '系统开发与供应链' } ] };
      if (statement.startsWith('SELECT psi.chapter_code_snapshot AS code')) return { rowCount: 3, rows: [
        { code: '6', name: '系统开发与供应链', item_count: 40 },
        { code: '7', name: '访问控制', item_count: 40 },
        { code: '8', name: '鉴别', item_count: 41 },
      ] };
      if (statement.startsWith('SELECT DISTINCT psi.chapter_code_snapshot AS chapter_code')) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [ { standard_item_id: 'item-1' } ] };
    },
  });
  const result = await repository.getProjectStandardAnswers({
    projectId: 'project-1', standardVersionId: 'version-1', search: '账号', chapterCode: '',
    status: 'not_satisfied', sortBy: 'status', sortDirection: 'desc', chapterPage: 2, chapterPageSize: '1',
  });
  assert.equal(result.pagination.totalChapters, 3);
  assert.equal(result.pagination.page, 2);
  assert.equal(result.pagination.pageCount, 3);
  assert.equal(result.items.length, 1);
  assert.equal(result.chapters[0].code, '7');
  const dataQuery = queries[4];
  assert.match(dataQuery.statement, /ORDER BY COALESCE\(sc\.sort_order, 0\)/);
  assert.match(dataQuery.statement, /ANY\(\$5::text\[\]\)/);
});
