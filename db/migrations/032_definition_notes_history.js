'use strict';

exports.up = pgm => {
  pgm.addColumns('supervision_definitions', {
    notes: { type: 'text' },
    change_history: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
  });
};

exports.down = pgm => {
  pgm.dropColumns('supervision_definitions', [ 'notes', 'change_history' ]);
};
