'use strict';

exports.up = pgm => {
  pgm.addColumn('projects', {
    is_template: { type: 'boolean', notNull: true, default: false },
    source_project_id: { type: 'uuid' },
  });
  pgm.addConstraint('projects', 'projects_source_project_fk', {
    foreignKeys: { columns: 'source_project_id', references: 'projects(id)', onDelete: 'SET NULL' },
  });
  pgm.addColumn('users', { last_project_id: { type: 'uuid' } });
  pgm.addConstraint('users', 'users_last_project_fk', {
    foreignKeys: { columns: 'last_project_id', references: 'projects(id)', onDelete: 'SET NULL' },
  });
  pgm.createIndex('projects', [ 'is_template', 'status' ], { name: 'projects_template_status_idx' });
};

exports.down = pgm => {
  pgm.dropIndex('projects', [ 'is_template', 'status' ], { name: 'projects_template_status_idx' });
  pgm.dropConstraint('users', 'users_last_project_fk');
  pgm.dropColumn('users', 'last_project_id');
  pgm.dropConstraint('projects', 'projects_source_project_fk');
  pgm.dropColumn('projects', [ 'is_template', 'source_project_id' ]);
};
