'use strict';

exports.up = pgm => {
  pgm.createSequence('supervision_definition_number_seq', { start: 1 });
  pgm.addColumn('supervision_definitions', {
    plan_number: { type: 'bigint' },
  });
  pgm.sql(`
    WITH numbered AS (
      SELECT id, row_number() OVER (ORDER BY created_at, id) AS number
      FROM supervision_definitions
    )
    UPDATE supervision_definitions d
    SET plan_number = numbered.number
    FROM numbered
    WHERE d.id = numbered.id;
  `);
  pgm.sql(`
    SELECT setval(
      'supervision_definition_number_seq',
      GREATEST(COALESCE((SELECT max(plan_number) FROM supervision_definitions), 0), 1),
      COALESCE((SELECT max(plan_number) FROM supervision_definitions), 0) > 0
    );
  `);
  pgm.alterColumn('supervision_definitions', 'plan_number', {
    notNull: true,
    default: pgm.func("nextval('supervision_definition_number_seq')"),
  });
  pgm.createIndex('supervision_definitions', 'plan_number', { unique: true });
};

exports.down = pgm => {
  pgm.dropIndex('supervision_definitions', 'plan_number', { ifExists: true });
  pgm.dropColumn('supervision_definitions', 'plan_number');
  pgm.dropSequence('supervision_definition_number_seq', { ifExists: true });
};
