'use strict';

exports.up = pgm => {
  pgm.addColumn('project_standard_items', {
    title_snapshot: { type: 'varchar(500)' },
  });
  pgm.sql(`
    UPDATE project_standard_items psi
    SET title_snapshot = si.title
    FROM standard_items si
    WHERE si.id = psi.standard_item_id
  `);
};

exports.down = pgm => {
  pgm.dropColumn('project_standard_items', 'title_snapshot');
};
