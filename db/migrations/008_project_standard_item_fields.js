'use strict';

exports.up = pgm => {
  pgm.addColumns('project_standard_answers', {
    standard_level: { type: 'varchar(100)' },
    is_key: { type: 'boolean', notNull: true, default: false },
    clause_assignment: { type: 'text' },
    unified_requirement: { type: 'text' },
    expected_evidence: { type: 'text' },
  });
  pgm.dropTable('standard_item_requirements');
  pgm.dropTable('legacy_standard_provider_assignments');
  pgm.dropColumns('standard_items', [ 'level', 'is_key', 'metadata' ]);
};

exports.down = pgm => {
  pgm.addColumns('standard_items', {
    level: { type: 'varchar(100)' },
    is_key: { type: 'boolean', notNull: true, default: false },
    metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
  });
  pgm.createTable('legacy_standard_provider_assignments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    standard_item_id: { type: 'uuid', notNull: true, references: 'standard_items', onDelete: 'CASCADE' },
    provider_name: { type: 'varchar(200)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('legacy_standard_provider_assignments', 'legacy_standard_provider_assignments_unique', {
    unique: [ 'standard_item_id', 'provider_name' ],
  });
  pgm.createTable('standard_item_requirements', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    standard_item_id: { type: 'uuid', notNull: true, references: 'standard_items', onDelete: 'CASCADE' },
    unified_requirement: { type: 'text', notNull: true },
    expected_evidence: { type: 'text' },
    sort_order: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.dropColumns('project_standard_answers', [
    'standard_level', 'is_key', 'clause_assignment', 'unified_requirement', 'expected_evidence',
  ]);
};
