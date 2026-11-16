'use strict';

exports.up = pgm => {
  pgm.addColumns('project_standard_answers', {
    assignment_details: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
  });
};

exports.down = pgm => {
  pgm.dropColumns('project_standard_answers', [ 'assignment_details' ]);
};
