'use strict';

// Migration 019 is already deployed. Keep it immutable. The project answer
// field cleanup is introduced by 020 so deployed databases receive it.
exports.up = pgm => {
  pgm.sql('ALTER TABLE project_standard_answers DROP COLUMN IF EXISTS legacy_measure_description');
};

exports.down = pgm => {
  pgm.addColumn('project_standard_answers', {
    legacy_measure_description: { type: 'text' },
  });
};
