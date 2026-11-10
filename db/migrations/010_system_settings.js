'use strict';

exports.up = pgm => {
  pgm.createTable('system_settings', {
    key: { type: 'varchar(100)', primaryKey: true },
    value: { type: 'text' },
    is_secret: { type: 'boolean', notNull: true, default: false },
    updated_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = pgm => {
  pgm.dropTable('system_settings');
};
