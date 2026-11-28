'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Repository = require('../app/repository/jointReview');

test('saves a human review decision with an audit record in one transaction', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      calls.push({ statement, values });
      if ([ 'BEGIN', 'COMMIT' ].includes(statement)) return { rows: [], rowCount: 0 };
      if (statement.startsWith('UPDATE supervision_joint_reviews')) {
        return {
          rows: [ {
            id: 'review-1',
            decision: 'confirmed_same_check',
            review_type: 'semantic_duplicate',
            project_id: 'project-1',
            chapter_id: 'chapter-1',
            definition_id: 'definition-1',
            standard_item_id: 'item-1',
            object_id: 'object-1',
          } ],
          rowCount: 1,
        };
      }
      if (statement.startsWith('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected query: ' + statement);
    },
    release() {},
  };
  const repository = new Repository({ connect: async () => client });
  const result = await repository.saveHumanDecision('review-1', {
    decision: 'confirmed_same_check',
    notes: 'EDR 与杀毒软件检查目的相同',
    reviewerId: 'user-1',
  });
  assert.equal(result.id, 'review-1');
  const update = calls.find(call => call.statement.startsWith('UPDATE supervision_joint_reviews'));
  assert.equal(update.values[1], 'confirmed_same_check');
  const audit = calls.find(call => call.statement.startsWith('INSERT INTO audit_logs'));
  assert.ok(audit);
  assert.equal(audit.values[1], 'review-1');
  const metadata = JSON.parse(audit.values[2]);
  assert.equal(metadata.decision, 'confirmed_same_check');
  assert.equal(metadata.chapterId, 'chapter-1');
  assert.equal(metadata.reviewType, 'semantic_duplicate');
  assert.ok(calls.some(call => call.statement === 'COMMIT'));
});
