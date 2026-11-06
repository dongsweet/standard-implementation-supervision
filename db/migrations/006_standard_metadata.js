'use strict';

exports.up = pgm => {
  pgm.addColumn('standards', {
    standard_type: { type: 'varchar(40)', notNull: true, default: 'other' },
    issuing_organization: { type: 'varchar(300)' },
  });
  pgm.sql(`
    UPDATE standards
    SET standard_type = 'national'
    WHERE upper(code) LIKE 'GB/%'
       OR upper(code) LIKE 'GB %'
       OR upper(code) LIKE 'GB-T%'
       OR upper(code) LIKE 'GB/T%'
  `);
  pgm.addConstraint('standards', 'standards_standard_type_check', {
    check: "standard_type IN ('national', 'industry', 'local', 'group', 'enterprise', 'internal', 'regulatory', 'other')",
  });
  pgm.createIndex('standards', [ 'standard_type', 'code' ], { name: 'standards_type_code_idx' });
};

exports.down = pgm => {
  pgm.dropIndex('standards', [ 'standard_type', 'code' ], { name: 'standards_type_code_idx' });
  pgm.dropConstraint('standards', 'standards_standard_type_check');
  pgm.dropColumn('standards', [ 'standard_type', 'issuing_organization' ]);
};
