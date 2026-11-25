'use strict';

exports.up = pgm => {
  pgm.createTable('supervision_object_categories', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'varchar(200)', notNull: true, unique: true },
    description: { type: 'text' },
    status: { type: 'varchar(30)', notNull: true, default: 'active' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTable('supervision_objects', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    canonical_name: { type: 'text', notNull: true },
    normalized_name: { type: 'text', notNull: true },
    category_id: { type: 'uuid', references: 'supervision_object_categories' },
    status: { type: 'varchar(30)', notNull: true, default: 'active' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('supervision_objects', 'normalized_name');
  pgm.createIndex('supervision_objects', 'category_id');
  pgm.createTable('supervision_object_aliases', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    object_id: { type: 'uuid', notNull: true, references: 'supervision_objects', onDelete: 'CASCADE' },
    alias_name: { type: 'text', notNull: true },
    normalized_name: { type: 'text', notNull: true },
    center_name: { type: 'varchar(200)' },
    source: { type: 'varchar(50)', notNull: true, default: 'import' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('supervision_object_aliases', [ 'object_id', 'center_name' ]);
  pgm.sql(`CREATE UNIQUE INDEX supervision_object_aliases_unique
    ON supervision_object_aliases (object_id, alias_name, COALESCE(center_name, ''))`);
  pgm.addColumn('supervision_definitions', {
    canonical_object_id: { type: 'uuid', references: 'supervision_objects' },
  });

  pgm.sql(`
    INSERT INTO supervision_object_categories (name)
    SELECT DISTINCT btrim(object_category)
    FROM supervision_definitions
    WHERE btrim(COALESCE(object_category, '')) <> ''
    ON CONFLICT (name) DO NOTHING;
  `);
  pgm.sql(`
    INSERT INTO supervision_objects (canonical_name, normalized_name, category_id)
    WITH grouped AS (
      SELECT btrim(d.object_name) AS object_name,
             lower(regexp_replace(btrim(d.object_name), '[[:space:][:punct:]]+', '', 'g')) AS normalized_name,
             CASE WHEN count(DISTINCT NULLIF(btrim(d.object_category), '')) = 1
               THEN min(NULLIF(btrim(d.object_category), '')) END AS category_name
      FROM supervision_definitions d
      WHERE btrim(COALESCE(d.object_name, '')) <> ''
      GROUP BY btrim(d.object_name)
    )
    SELECT grouped.object_name,
           grouped.normalized_name,
           c.id
    FROM grouped LEFT JOIN supervision_object_categories c ON c.name = grouped.category_name
    ON CONFLICT DO NOTHING;
  `);
  pgm.sql(`
    UPDATE supervision_definitions d
    SET canonical_object_id = o.id
    FROM supervision_objects o
    WHERE d.canonical_object_id IS NULL
      AND o.canonical_name = btrim(d.object_name);
  `);
  pgm.sql(`
    INSERT INTO supervision_object_aliases (object_id, alias_name, normalized_name, center_name, source)
    SELECT d.canonical_object_id, btrim(d.object_name),
           lower(regexp_replace(btrim(d.object_name), '[[:space:][:punct:]]+', '', 'g')),
           dc.center_name, 'migration'
    FROM supervision_definitions d
    JOIN supervision_definition_centers dc ON dc.definition_id = d.id
    WHERE d.canonical_object_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  `);
  pgm.sql(`
    INSERT INTO supervision_object_aliases (object_id, alias_name, normalized_name, center_name, source)
    SELECT d.canonical_object_id, btrim(d.object_name),
           lower(regexp_replace(btrim(d.object_name), '[[:space:][:punct:]]+', '', 'g')),
           NULL, 'migration'
    FROM supervision_definitions d
    WHERE d.canonical_object_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM supervision_definition_centers dc WHERE dc.definition_id = d.id)
    ON CONFLICT DO NOTHING;
  `);
};

exports.down = pgm => {
  pgm.dropColumn('supervision_definitions', 'canonical_object_id');
  pgm.dropTable('supervision_object_aliases');
  pgm.dropTable('supervision_objects');
  pgm.dropTable('supervision_object_categories');
};
