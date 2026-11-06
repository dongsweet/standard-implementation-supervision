'use strict';

exports.up = pgm => {
  pgm.dropIndex('projects', [ 'is_template', 'status' ], { name: 'projects_template_status_idx' });
  pgm.dropColumn('projects', 'is_template');
};

exports.down = pgm => {
  pgm.addColumn('projects', { is_template: { type: 'boolean', notNull: true, default: false } });
  pgm.createIndex('projects', [ 'is_template', 'status' ], { name: 'projects_template_status_idx' });
};
