'use strict';

exports.up = pgm => {
  pgm.renameColumn('standard_item_requirements', 'implementation_evidence', 'expected_evidence');
  pgm.renameTable('standard_provider_assignments', 'legacy_standard_provider_assignments');
  pgm.sql(`
    UPDATE standard_items
    SET metadata = (metadata - 'providerAssignment')
      || jsonb_build_object('clauseAssignment', metadata -> 'providerAssignment')
    WHERE metadata ? 'providerAssignment'
      AND NOT metadata ? 'clauseAssignment'
  `);
  pgm.addColumns('project_standard_answers', {
    applicability: { type: 'varchar(30)', notNull: true, default: 'unspecified' },
    applicability_scope: { type: 'text' },
    actual_evidence: { type: 'text' },
  });
  pgm.sql(`
    UPDATE project_standard_answers
    SET applicability = 'not_applicable',
        status = 'unassessed'
    WHERE status = 'not_applicable'
  `);
  pgm.addConstraint('project_standard_answers', 'project_standard_answers_applicability_check', {
    check: "applicability IN ('unspecified', 'applicable', 'not_applicable')",
  });
};

exports.down = pgm => {
  pgm.dropConstraint('project_standard_answers', 'project_standard_answers_applicability_check');
  pgm.dropColumns('project_standard_answers', [ 'applicability', 'applicability_scope', 'actual_evidence' ]);
  pgm.sql(`
    UPDATE standard_items
    SET metadata = (metadata - 'clauseAssignment')
      || jsonb_build_object('providerAssignment', metadata -> 'clauseAssignment')
    WHERE metadata ? 'clauseAssignment'
      AND NOT metadata ? 'providerAssignment'
  `);
  pgm.renameTable('legacy_standard_provider_assignments', 'standard_provider_assignments');
  pgm.renameColumn('standard_item_requirements', 'expected_evidence', 'implementation_evidence');
};
