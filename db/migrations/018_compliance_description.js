'use strict';

exports.up = pgm => {
  pgm.renameColumn('project_standard_answers', 'unified_requirement', 'compliance_description');
  pgm.sql('ALTER TABLE project_standard_answers RENAME COLUMN measure_description TO legacy_measure_description');
  // The legacy description was empty in production, but retain the column so
  // manual values remain recoverable instead of being silently discarded.
};

exports.down = pgm => {
  pgm.sql('ALTER TABLE project_standard_answers RENAME COLUMN legacy_measure_description TO measure_description');
  pgm.renameColumn('project_standard_answers', 'compliance_description', 'unified_requirement');
};
