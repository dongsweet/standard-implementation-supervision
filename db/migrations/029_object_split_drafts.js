'use strict';

exports.up = pgm => {
  pgm.createTable('supervision_object_split_drafts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    source_object_id: { type: 'uuid', notNull: true, references: 'supervision_objects' },
    status: { type: 'varchar(30)', notNull: true, default: 'draft' },
    groups: { type: 'jsonb', notNull: true },
    created_by: { type: 'uuid', references: 'users' },
    submitted_by: { type: 'uuid', references: 'users' },
    submitted_at: { type: 'timestamptz' },
    result: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('supervision_object_split_drafts', [ 'source_object_id', 'status' ]);
  pgm.createIndex('supervision_object_split_drafts', 'source_object_id', {
    unique: true,
    where: "status = 'draft'",
    name: 'supervision_object_split_drafts_one_pending',
  });
  pgm.createIndex('supervision_object_split_drafts', 'created_by');
  pgm.addColumn('supervision_objects', {
    split_into_draft_id: { type: 'uuid', references: 'supervision_object_split_drafts' },
  });
};

exports.down = pgm => {
  pgm.dropColumn('supervision_objects', 'split_into_draft_id');
  pgm.dropTable('supervision_object_split_drafts');
};
