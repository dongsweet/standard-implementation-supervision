'use strict';

exports.up = pgm => {
  pgm.createTable('supervision_object_dedupe_reviews', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    center_name: { type: 'varchar(200)', notNull: true },
    left_object_name: { type: 'text', notNull: true },
    right_object_name: { type: 'text', notNull: true },
    decision: { type: 'varchar(40)', notNull: true },
    canonical_object_name: { type: 'text' },
    reviewer_id: { type: 'uuid', references: 'users' },
    notes: { type: 'text' },
    affected_plan_ids: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('supervision_object_dedupe_reviews', [ 'center_name' ]);

  pgm.createTable('ai_supervision_object_dedupe_jobs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    center_name: { type: 'varchar(200)', notNull: true },
    left_object_name: { type: 'text', notNull: true },
    right_object_name: { type: 'text', notNull: true },
    input_hash: { type: 'varchar(64)', notNull: true },
    algorithm_version: { type: 'varchar(50)', notNull: true },
    prompt_version: { type: 'varchar(50)' },
    model_name: { type: 'varchar(200)' },
    status: { type: 'varchar(30)', notNull: true, default: 'pending' },
    provider_status: { type: 'integer' },
    duration_ms: { type: 'integer' },
    result: { type: 'jsonb' },
    error_message: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    completed_at: { type: 'timestamptz' },
  });
  pgm.createIndex(
    'ai_supervision_object_dedupe_jobs',
    [ 'input_hash', 'model_name', 'prompt_version' ],
    { unique: true }
  );
};

exports.down = pgm => {
  pgm.dropTable('ai_supervision_object_dedupe_jobs');
  pgm.dropTable('supervision_object_dedupe_reviews');
};
