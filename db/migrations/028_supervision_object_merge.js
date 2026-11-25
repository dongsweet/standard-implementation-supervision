'use strict';

exports.up = pgm => {
  pgm.addColumn('supervision_objects', {
    merged_into_id: { type: 'uuid', references: 'supervision_objects' },
  });
  pgm.createIndex('supervision_objects', 'merged_into_id');
};

exports.down = pgm => {
  pgm.dropColumn('supervision_objects', 'merged_into_id');
};
