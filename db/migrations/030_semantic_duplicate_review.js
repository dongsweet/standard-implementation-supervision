'use strict';

exports.up = pgm => {
  pgm.addColumn('supervision_joint_reviews', {
    chapter_id: { type: 'uuid', references: 'standard_chapters' },
  });
  pgm.createIndex('supervision_joint_reviews', [ 'project_id', 'chapter_id', 'review_type' ]);
};

exports.down = pgm => {
  pgm.dropColumn('supervision_joint_reviews', 'chapter_id');
};
