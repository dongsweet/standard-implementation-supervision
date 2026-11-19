'use strict';

exports.up = pgm => {
  pgm.addColumns('supervision_definitions', {
    scope: { type: 'varchar(200)' },
    recognized_object: { type: 'boolean' },
    priority: { type: 'varchar(50)' },
    reference_result: { type: 'text' },
    reference_materials: { type: 'text' },
  });
  pgm.createTable('supervision_plan_import_jobs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    original_filename: { type: 'varchar(500)', notNull: true },
    status: { type: 'varchar(30)', notNull: true, default: 'ready' },
    payload: { type: 'jsonb', notNull: true },
    created_by: { type: 'uuid', references: 'users' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    applied_at: { type: 'timestamptz' },
  });
  pgm.createIndex('supervision_plan_import_jobs', 'created_at');
};

exports.down = pgm => {
  pgm.dropTable('supervision_plan_import_jobs');
  pgm.dropColumns('supervision_definitions', [
    'scope', 'recognized_object', 'priority', 'reference_result', 'reference_materials',
  ]);
};
