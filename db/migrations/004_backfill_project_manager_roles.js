'use strict';

exports.up = pgm => {
  pgm.sql(`
    INSERT INTO user_roles (user_id, role_id, project_id)
    SELECT p.project_manager_id, r.id, p.id
    FROM projects p CROSS JOIN roles r
    WHERE p.project_manager_id IS NOT NULL AND r.code = 'project_admin'
    ON CONFLICT DO NOTHING`);
};

exports.down = () => {};
