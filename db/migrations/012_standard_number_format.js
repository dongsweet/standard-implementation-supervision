'use strict';

exports.up = pgm => {
  pgm.addColumn('standard_items', {
    import_order: { type: 'integer' },
  });
  pgm.dropIndex('standard_chapters', 'standard_number', { name: 'standard_chapters_standard_number_unique' });
  pgm.dropIndex('standard_items', 'standard_number', { name: 'standard_items_standard_number_unique' });
  pgm.sql('ALTER TABLE standard_chapters ALTER COLUMN standard_number TYPE varchar(200)');
  pgm.sql('ALTER TABLE standard_items ALTER COLUMN standard_number TYPE varchar(200)');
  pgm.sql('ALTER TABLE project_standard_items ALTER COLUMN standard_number_snapshot TYPE varchar(200)');

  pgm.sql(`
    WITH numbered AS (
      SELECT si.id,
             row_number() OVER (PARTITION BY si.chapter_id ORDER BY si.item_code, si.id)::integer AS import_order
      FROM standard_items si
    )
    UPDATE standard_items si
    SET import_order = numbered.import_order
    FROM numbered
    WHERE numbered.id = si.id
  `);
  pgm.sql('ALTER TABLE standard_items ALTER COLUMN import_order SET NOT NULL');
  pgm.sql(`
    WITH chapter_base AS (
      SELECT sc.id, sc.code, sc.standard_version_id,
             row_number() OVER (PARTITION BY sc.standard_version_id ORDER BY sc.sort_order, sc.code, sc.id)::integer AS chapter_order,
             trim(both '-' from regexp_replace(regexp_replace(upper(s.code), '[^0-9A-Z]+', '-', 'g'), '^[^0-9]*', '')) AS prefix,
             trim(both '-' from regexp_replace(upper(sc.code), '[^0-9A-Z._-]+', '-', 'g')) AS chapter_part
      FROM standard_chapters sc
      JOIN standard_versions sv ON sv.id = sc.standard_version_id
      JOIN standards s ON s.id = sv.standard_id
    )
    UPDATE standard_chapters sc
    SET standard_number = chapter_base.prefix || '-' || CASE
      WHEN chapter_base.code ~ '[0-9]' AND chapter_base.chapter_part <> '' THEN chapter_base.chapter_part
      ELSE 'C' || lpad(chapter_base.chapter_order::text, 3, '0')
    END
    FROM chapter_base
    WHERE chapter_base.id = sc.id
  `);
  pgm.sql(`
    WITH item_base AS (
      SELECT si.id, si.import_order, sc.code, sc.standard_version_id,
             row_number() OVER (PARTITION BY sc.standard_version_id ORDER BY sc.sort_order, sc.code, sc.id)::integer AS chapter_order,
             trim(both '-' from regexp_replace(regexp_replace(upper(s.code), '[^0-9A-Z]+', '-', 'g'), '^[^0-9]*', '')) AS prefix,
             trim(both '-' from regexp_replace(upper(sc.code), '[^0-9A-Z._-]+', '-', 'g')) AS chapter_part
      FROM standard_items si
      JOIN standard_chapters sc ON sc.id = si.chapter_id
      JOIN standard_versions sv ON sv.id = si.standard_version_id
      JOIN standards s ON s.id = sv.standard_id
    )
    UPDATE standard_items si
    SET standard_number = item_base.prefix || '-' || CASE
      WHEN item_base.code ~ '[0-9]' AND item_base.chapter_part <> '' THEN item_base.chapter_part
      ELSE 'C' || lpad(item_base.chapter_order::text, 3, '0')
    END || '-' || lpad(item_base.import_order::text, 4, '0')
    FROM item_base
    WHERE item_base.id = si.id
  `);
  pgm.createIndex('standard_chapters', [ 'standard_version_id', 'standard_number' ], {
    unique: true,
    name: 'standard_chapters_version_standard_number_unique',
  });
  pgm.createIndex('standard_items', [ 'standard_version_id', 'standard_number' ], {
    unique: true,
    name: 'standard_items_version_standard_number_unique',
  });
};

exports.down = pgm => {
  pgm.dropIndex('standard_items', [ 'standard_version_id', 'standard_number' ], { name: 'standard_items_version_standard_number_unique' });
  pgm.dropIndex('standard_chapters', [ 'standard_version_id', 'standard_number' ], { name: 'standard_chapters_version_standard_number_unique' });
  pgm.sql('ALTER TABLE project_standard_items ALTER COLUMN standard_number_snapshot TYPE varchar(30)');
  pgm.sql('ALTER TABLE standard_items ALTER COLUMN standard_number TYPE varchar(30)');
  pgm.sql('ALTER TABLE standard_chapters ALTER COLUMN standard_number TYPE varchar(30)');
  pgm.createIndex('standard_chapters', 'standard_number', { unique: true, name: 'standard_chapters_standard_number_unique' });
  pgm.createIndex('standard_items', 'standard_number', { unique: true, name: 'standard_items_standard_number_unique' });
  pgm.dropColumn('standard_items', 'import_order');
};
