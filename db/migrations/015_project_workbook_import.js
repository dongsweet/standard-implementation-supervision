'use strict';

exports.up = pgm => {
  pgm.addColumns('project_standard_answers', {
    pending_evidence: { type: 'text' },
    responsible_text: { type: 'text' },
  });
  pgm.createTable('project_data_import_jobs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'projects', onDelete: 'CASCADE' },
    original_filename: { type: 'varchar(500)', notNull: true },
    status: { type: 'varchar(30)', notNull: true, default: 'ready' },
    payload: { type: 'jsonb', notNull: true },
    cloud_mapping: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_by: { type: 'uuid', references: 'users' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    applied_at: { type: 'timestamptz' },
  });
  pgm.createIndex('project_data_import_jobs', [ 'project_id', 'created_at' ]);
};

exports.down = pgm => {
  pgm.dropTable('project_data_import_jobs');
  pgm.dropColumns('project_standard_answers', [ 'pending_evidence', 'responsible_text' ]);
};
