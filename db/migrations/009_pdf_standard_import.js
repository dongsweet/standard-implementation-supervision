'use strict';

exports.up = pgm => {
  pgm.sql('CREATE SEQUENCE standard_chapter_number_seq');
  pgm.sql('CREATE SEQUENCE standard_item_number_seq');
  pgm.addColumns('standard_chapters', {
    standard_number: { type: 'varchar(30)' },
  });
  pgm.addColumns('standard_items', {
    standard_number: { type: 'varchar(30)' },
    source_page_from: { type: 'integer' },
    source_page_to: { type: 'integer' },
    source_excerpt: { type: 'text' },
  });
  pgm.sql(`
    WITH numbered AS (
      SELECT id, row_number() OVER (ORDER BY standard_version_id, sort_order, code) AS number
      FROM standard_chapters
    )
    UPDATE standard_chapters sc
    SET standard_number = 'SC-' || lpad(numbered.number::text, 8, '0')
    FROM numbered WHERE numbered.id = sc.id
  `);
  pgm.sql(`
    WITH numbered AS (
      SELECT id, row_number() OVER (ORDER BY standard_version_id, chapter_id, item_code) AS number
      FROM standard_items
    )
    UPDATE standard_items si
    SET standard_number = 'SI-' || lpad(numbered.number::text, 8, '0')
    FROM numbered WHERE numbered.id = si.id
  `);
  pgm.sql(`
    SELECT setval('standard_chapter_number_seq', COALESCE((SELECT max(substring(standard_number from 4)::integer) FROM standard_chapters), 0) + 1, false)
  `);
  pgm.sql(`
    SELECT setval('standard_item_number_seq', COALESCE((SELECT max(substring(standard_number from 4)::integer) FROM standard_items), 0) + 1, false)
  `);
  pgm.sql(`ALTER TABLE standard_chapters ALTER COLUMN standard_number SET DEFAULT 'SC-' || lpad(nextval('standard_chapter_number_seq')::text, 8, '0')`);
  pgm.sql(`ALTER TABLE standard_items ALTER COLUMN standard_number SET DEFAULT 'SI-' || lpad(nextval('standard_item_number_seq')::text, 8, '0')`);
  pgm.sql('ALTER TABLE standard_chapters ALTER COLUMN standard_number SET NOT NULL');
  pgm.sql('ALTER TABLE standard_items ALTER COLUMN standard_number SET NOT NULL');
  pgm.createIndex('standard_chapters', 'standard_number', { unique: true, name: 'standard_chapters_standard_number_unique' });
  pgm.createIndex('standard_items', 'standard_number', { unique: true, name: 'standard_items_standard_number_unique' });

  pgm.addColumns('project_standard_items', {
    standard_number_snapshot: { type: 'varchar(30)' },
  });
  pgm.sql(`
    UPDATE project_standard_items psi
    SET standard_number_snapshot = si.standard_number
    FROM standard_items si
    WHERE si.id = psi.standard_item_id
  `);

  pgm.createTable('standard_import_jobs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    standard_version_id: { type: 'uuid', notNull: true, references: 'standard_versions', onDelete: 'CASCADE' },
    original_filename: { type: 'varchar(500)', notNull: true },
    storage_key: { type: 'text', notNull: true },
    status: { type: 'varchar(30)', notNull: true, default: 'queued' },
    progress: { type: 'integer', notNull: true, default: 0 },
    page_count: { type: 'integer' },
    result: { type: 'jsonb' },
    error_message: { type: 'text' },
    created_by: { type: 'uuid', references: 'users' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    completed_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('standard_import_jobs', 'standard_import_jobs_status_check', {
    check: "status IN ('queued', 'processing', 'ready', 'failed', 'applying', 'completed')",
  });
  pgm.createIndex('standard_import_jobs', [ 'standard_version_id', 'created_at' ], {
    name: 'standard_import_jobs_version_created_idx',
  });
  pgm.addColumns('standard_items', {
    import_job_id: { type: 'uuid', references: 'standard_import_jobs', onDelete: 'SET NULL' },
  });
};

exports.down = pgm => {
  pgm.dropColumn('standard_items', 'import_job_id');
  pgm.dropTable('standard_import_jobs');
  pgm.dropColumn('project_standard_items', 'standard_number_snapshot');
  pgm.dropIndex('standard_items', 'standard_number', { name: 'standard_items_standard_number_unique' });
  pgm.dropIndex('standard_chapters', 'standard_number', { name: 'standard_chapters_standard_number_unique' });
  pgm.dropColumns('standard_items', [ 'standard_number', 'source_page_from', 'source_page_to', 'source_excerpt' ]);
  pgm.dropColumns('standard_chapters', [ 'standard_number' ]);
  pgm.sql('DROP SEQUENCE standard_item_number_seq');
  pgm.sql('DROP SEQUENCE standard_chapter_number_seq');
};
