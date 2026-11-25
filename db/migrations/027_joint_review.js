'use strict';

exports.up = pgm => {
  pgm.createTable('supervision_joint_reviews', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    review_type: { type: 'varchar(40)', notNull: true },
    severity: { type: 'varchar(20)', notNull: true, default: 'info' },
    fingerprint: { type: 'varchar(64)', notNull: true, unique: true },
    context_hash: { type: 'varchar(64)', notNull: true },
    standard_item_id: { type: 'uuid', references: 'standard_items' },
    project_id: { type: 'uuid', references: 'projects' },
    definition_id: { type: 'uuid', references: 'supervision_definitions' },
    object_id: { type: 'uuid', references: 'supervision_objects' },
    title: { type: 'text', notNull: true },
    summary: { type: 'text', notNull: true },
    rule_reason: { type: 'text' },
    context: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    ai_status: { type: 'varchar(30)', notNull: true, default: 'pending' },
    ai_result: { type: 'jsonb' },
    ai_model: { type: 'varchar(200)' },
    prompt_version: { type: 'varchar(50)' },
    ai_input_hash: { type: 'varchar(64)' },
    ai_error: { type: 'text' },
    ai_reviewed_at: { type: 'timestamptz' },
    human_decision: { type: 'varchar(40)' },
    human_notes: { type: 'text' },
    reviewer_id: { type: 'uuid', references: 'users' },
    reviewed_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('supervision_joint_reviews', [ 'review_type', 'severity' ]);
  pgm.createIndex('supervision_joint_reviews', 'definition_id');
  pgm.createIndex('supervision_joint_reviews', 'object_id');
  pgm.createIndex('supervision_joint_reviews', 'standard_item_id');
  pgm.createIndex('supervision_joint_reviews', 'project_id');
  pgm.createIndex('supervision_joint_reviews', 'human_decision');
};

exports.down = pgm => {
  pgm.dropTable('supervision_joint_reviews');
};
