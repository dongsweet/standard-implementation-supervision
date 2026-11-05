'use strict';

exports.up = pgm => {
  pgm.createIndex('standard_chapters', [ 'standard_version_id', 'code' ], {
    unique: true,
    name: 'standard_chapters_version_code_unique',
  });
};

exports.down = pgm => {
  pgm.dropIndex('standard_chapters', [ 'standard_version_id', 'code' ], { name: 'standard_chapters_version_code_unique' });
};
