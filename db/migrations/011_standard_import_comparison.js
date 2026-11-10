'use strict';

exports.up = pgm => {
  pgm.addColumns('standard_import_jobs', {
    comparison_filename: { type: 'varchar(500)' },
    comparison_storage_key: { type: 'text' },
    comparison_result: { type: 'jsonb' },
  });
};

exports.down = pgm => {
  pgm.dropColumns('standard_import_jobs', [
    'comparison_filename',
    'comparison_storage_key',
    'comparison_result',
  ]);
};
