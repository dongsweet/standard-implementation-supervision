'use strict';

exports.up = pgm => {
  pgm.sql(`
    UPDATE project_standard_items psi
    SET standard_number_snapshot = si.standard_number,
        heading_path_snapshot = si.heading_path
    FROM standard_items si
    WHERE si.id = psi.standard_item_id
  `);
};

exports.down = pgm => {};
