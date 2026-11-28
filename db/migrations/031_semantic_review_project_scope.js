'use strict';

exports.up = pgm => {
  pgm.addColumn('supervision_joint_reviews', {
    chapter_ids: { type: 'uuid[]', notNull: true, default: pgm.func("'{}'::uuid[]") },
  });
  pgm.sql(`
    UPDATE supervision_joint_reviews
    SET chapter_ids = ARRAY[chapter_id]::uuid[]
    WHERE chapter_id IS NOT NULL
  `);
  pgm.createIndex('supervision_joint_reviews', 'chapter_ids', { method: 'gin' });
};

exports.down = pgm => {
  pgm.dropColumn('supervision_joint_reviews', 'chapter_ids');
};
