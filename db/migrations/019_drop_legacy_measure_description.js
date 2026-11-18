'use strict';

exports.up = pgm => {
  pgm.sql('ALTER TABLE project_standard_answers DROP COLUMN legacy_measure_description');
};

exports.down = pgm => {
  pgm.addColumn('project_standard_answers', {
    legacy_measure_description: { type: 'text' },
  });
};
