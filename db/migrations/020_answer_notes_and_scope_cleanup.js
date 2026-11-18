'use strict';

exports.up = pgm => {
  // Level is already represented by the standard heading hierarchy, while
  // cloud-center applicability is represented by separate scoped answers.
  pgm.sql('ALTER TABLE project_standard_answers DROP COLUMN IF EXISTS standard_level');
  pgm.sql('ALTER TABLE project_standard_answers DROP COLUMN IF EXISTS applicability_scope');
  pgm.renameColumn('project_standard_answers', 'problem_description', 'answer_notes');
};

exports.down = pgm => {
  pgm.renameColumn('project_standard_answers', 'answer_notes', 'problem_description');
  pgm.addColumn('project_standard_answers', {
    standard_level: { type: 'varchar(100)' },
    applicability_scope: { type: 'text' },
  });
};
