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
  assert.match(snapshotInsert.statement, /SELECT \$1, si\.id, si\.standard_number, si\.item_code, si\.title, COALESCE\(si\.explanation, parent\.explanation\), si\.content, sc\.code, si\.heading_path, now\(\)/);
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

test('loads project overview as summaries without querying all standard item rows', async () => {
  const queries = [];
  const repository = new ProjectRepository({
    async query(sql, values) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      queries.push(statement);
      if (statement.startsWith('SELECT p.*, source_project.name')) return { rows: [ { id: 'project-1', name: '项目A' } ], rowCount: 1 };
      if (statement.startsWith('SELECT psv.snapshot_at')) return { rows: [ { standard_code: '31168', item_count: 526, answered_count: 120 } ], rowCount: 1 };
      throw new Error(`Unexpected query: ${statement}`);
    },
  });
  const result = await repository.getProjectDetail('project-1');
  assert.equal(result.versions[0].item_count, 526);
  assert.equal(result.versions[0].answered_count, 120);
  assert.equal(queries.length, 2);
  assert.equal(queries.some(statement => statement.includes('ORDER BY psi.chapter_code_snapshot')), false);
});

test('syncs a project standard snapshot atomically while preserving project answers', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: 0 };
      if (statement.startsWith('SELECT psv.project_id, psv.standard_version_id')) {
        return { rows: [ { project_id: 'project-1', standard_version_id: 'version-1', standard_code: '31168', version: '2023' } ], rowCount: 1 };
      }
      if (statement.startsWith('SELECT count(si.id)::integer AS total_count')) {
        return { rows: [ { total_count: 10, added_count: 2, updated_count: 3 } ], rowCount: 1 };
      }
      if (statement.startsWith('INSERT INTO project_standard_items')) return { rows: [], rowCount: 5 };
      if (statement.startsWith('UPDATE project_standard_versions')) return { rows: [], rowCount: 1 };
      if (statement.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${statement}`);
    },
    release() {},
  };
  const repository = new ProjectRepository({ connect: async () => client });
  const result = await repository.syncProjectStandardVersion({ projectId: 'project-1', standardVersionId: 'version-1', actorId: 'user-1' });
  assert.deepEqual(result, { totalCount: 10, addedCount: 2, updatedCount: 3, unchangedCount: 5 });
  const syncWrite = calls.find(call => call.statement.startsWith('INSERT INTO project_standard_items'));
  assert.match(syncWrite.statement, /ON CONFLICT \(project_id, standard_item_id\) DO UPDATE/);
  assert.match(syncWrite.statement, /title_snapshot = EXCLUDED\.title_snapshot/);
  assert.match(syncWrite.statement, /explanation_snapshot = EXCLUDED\.explanation_snapshot/);
  assert.match(syncWrite.statement, /content_snapshot = EXCLUDED\.content_snapshot/);
  assert.ok(calls.some(call => call.statement.startsWith('UPDATE project_standard_versions SET snapshot_at')));
  assert.ok(calls.some(call => call.statement.startsWith('INSERT INTO audit_logs')));
  assert.ok(calls.some(call => call.statement === 'COMMIT'));
});

test('rejects snapshot sync if the standard version is not part of the project', async () => {
  let released = false;
  const client = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if ([ 'BEGIN', 'ROLLBACK' ].includes(statement)) return { rows: [], rowCount: 0 };
      if (statement.startsWith('SELECT psv.project_id, psv.standard_version_id')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${statement}`);
    },
    release() { released = true; },
  };
  const repository = new ProjectRepository({ connect: async () => client });
  await assert.rejects(
    repository.syncProjectStandardVersion({ projectId: 'project-1', standardVersionId: 'version-other' }),
    error => error.code === 'PROJECT_STANDARD_VERSION_NOT_FOUND',
  );
  assert.equal(released, true);
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
  const dataQuery = queries[3];
  assert.match(dataQuery.statement, /ORDER BY COALESCE\(sc\.sort_order, 0\)/);
  assert.match(dataQuery.statement, /ANY\(\$5::text\[\]\)/);
});
