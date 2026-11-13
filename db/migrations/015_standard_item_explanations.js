'use strict';

exports.up = pgm => {
  pgm.addColumn('standard_items', {
    explanation: { type: 'text' },
  });
  pgm.addColumn('project_standard_items', {
    explanation_snapshot: { type: 'text' },
  });
  pgm.sql(`
    UPDATE project_standard_items psi
    SET explanation_snapshot = si.explanation
    FROM standard_items si
    WHERE si.id = psi.standard_item_id
  `);
};

exports.down = pgm => {
  pgm.dropColumn('project_standard_items', 'explanation_snapshot');
  pgm.dropColumn('standard_items', 'explanation');
};
