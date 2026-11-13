'use strict';

exports.up = pgm => {
  pgm.addColumn('standard_items', {
    heading_path: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
  });
  pgm.addColumn('project_standard_items', {
    heading_path_snapshot: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
  });
  pgm.sql(`
    UPDATE project_standard_items psi
    SET heading_path_snapshot = si.heading_path
    FROM standard_items si
    WHERE si.id = psi.standard_item_id
  `);

  pgm.dropIndex('standard_chapters', [ 'standard_version_id', 'standard_number' ], {
    name: 'standard_chapters_version_standard_number_unique',
  });
  pgm.sql(`
    UPDATE standard_items
    SET standard_number = 'TEMP-' || id::text
  `);
  pgm.sql(`
    WITH chapter_roots AS (
      SELECT sc.standard_version_id,
             COALESCE(substring(sc.code FROM '^([0-9]+)'), 'C' || lpad(
               row_number() OVER (PARTITION BY sc.standard_version_id ORDER BY sc.sort_order, sc.code, sc.id)::text,
               3, '0'
             )) AS root_code
      FROM standard_chapters sc
    ),
    root_widths AS (
      SELECT standard_version_id,
             GREATEST(2, length(COALESCE(max(CASE WHEN root_code ~ '^[0-9]+$' THEN root_code END), '0'))) AS chapter_width
      FROM chapter_roots
      GROUP BY standard_version_id
    ),
    chapter_base AS (
      SELECT sc.id, sc.code, sc.standard_version_id, sv.version,
             trim(both '-' from regexp_replace(regexp_replace(upper(s.code), '[^0-9A-Z]+', '-', 'g'), '^[^0-9]*', '')) AS standard_part,
             trim(both '-' from regexp_replace(upper(sv.version), '[^0-9A-Z]+', '-', 'g')) AS version_part,
             COALESCE(substring(sc.code FROM '^([0-9]+)'), 'C' || lpad(
               row_number() OVER (PARTITION BY sc.standard_version_id ORDER BY sc.sort_order, sc.code, sc.id)::text,
               3, '0'
             )) AS root_code,
             rw.chapter_width
      FROM standard_chapters sc
      JOIN standard_versions sv ON sv.id = sc.standard_version_id
      JOIN standards s ON s.id = sv.standard_id
      JOIN root_widths rw ON rw.standard_version_id = sc.standard_version_id
    )
    UPDATE standard_chapters sc
    SET standard_number = chapter_base.standard_part || '-' || chapter_base.version_part || '-' ||
      CASE WHEN chapter_base.root_code ~ '^[0-9]+$'
        THEN lpad(chapter_base.root_code, chapter_base.chapter_width, '0')
        ELSE chapter_base.root_code
      END
    FROM chapter_base
    WHERE chapter_base.id = sc.id
  `);
  pgm.sql(`
    WITH item_rows AS (
      SELECT si.id, si.standard_version_id, si.item_code, si.import_order,
             sc.code AS chapter_code, sc.sort_order AS chapter_sort_order,
             trim(both '-' from regexp_replace(regexp_replace(upper(s.code), '[^0-9A-Z]+', '-', 'g'), '^[^0-9]*', '')) AS standard_part,
             trim(both '-' from regexp_replace(upper(sv.version), '[^0-9A-Z]+', '-', 'g')) AS version_part,
             COALESCE(substring(sc.code FROM '^([0-9]+)'), 'C' || lpad(
               row_number() OVER (PARTITION BY sc.standard_version_id ORDER BY sc.sort_order, sc.code, sc.id)::text,
               3, '0'
             )) AS root_code
      FROM standard_items si
      JOIN standard_chapters sc ON sc.id = si.chapter_id
      JOIN standard_versions sv ON sv.id = si.standard_version_id
      JOIN standards s ON s.id = sv.standard_id
    ),
    grouped AS (
      SELECT item_rows.*,
             row_number() OVER (PARTITION BY standard_version_id, root_code
               ORDER BY chapter_sort_order, chapter_code, import_order, item_code, id)::integer AS item_order,
             count(*) OVER (PARTITION BY standard_version_id, root_code)::integer AS item_count
      FROM item_rows
    ),
    widths AS (
      SELECT standard_version_id, root_code,
             GREATEST(3, length(max(item_count)::text)) AS item_width,
             GREATEST(2, length(COALESCE(max(CASE WHEN root_code ~ '^[0-9]+$' THEN root_code END), '0'))) AS chapter_width
      FROM grouped
      GROUP BY standard_version_id, root_code
    )
    UPDATE standard_items si
    SET standard_number = grouped.standard_part || '-' || grouped.version_part || '-' ||
      CASE WHEN grouped.root_code ~ '^[0-9]+$'
        THEN lpad(grouped.root_code, widths.chapter_width, '0')
        ELSE grouped.root_code
      END || lpad(grouped.item_order::text, widths.item_width, '0'),
      import_order = grouped.item_order
    FROM grouped
    JOIN widths USING (standard_version_id, root_code)
    WHERE grouped.id = si.id
  `);
  pgm.sql(`
    UPDATE project_standard_items psi
    SET standard_number_snapshot = si.standard_number
    FROM standard_items si
    WHERE si.id = psi.standard_item_id
  `);
  pgm.createIndex('standard_chapters', [ 'standard_version_id', 'standard_number' ], {
    name: 'standard_chapters_version_standard_number_idx',
  });
};

exports.down = pgm => {
  pgm.dropIndex('standard_chapters', [ 'standard_version_id', 'standard_number' ], {
    name: 'standard_chapters_version_standard_number_idx',
  });
  pgm.dropColumn('project_standard_items', 'heading_path_snapshot');
  pgm.dropColumn('standard_items', 'heading_path');
  pgm.createIndex('standard_chapters', [ 'standard_version_id', 'standard_number' ], {
    unique: true,
    name: 'standard_chapters_version_standard_number_unique',
  });
};
