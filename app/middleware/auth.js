'use strict';

module.exports = () => {
  return async function authenticate(ctx, next) {
    if ([ '/login', '/health' ].includes(ctx.path) || ctx.path.startsWith('/public/')) return next();
    const userId = ctx.session.userId;
    if (!userId) {
      if (ctx.path.startsWith('/api/')) ctx.throw(401, '请先登录');
      ctx.redirect('/login');
      return;
    }
    const result = await ctx.app.db.query(`
      SELECT u.id, u.username, u.display_name, u.last_project_id,
             COALESCE(json_agg(json_build_object('code', r.code, 'scope', r.scope, 'projectId', ur.project_id))
               FILTER (WHERE r.code IS NOT NULL), '[]'::json) AS roles
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON r.id = ur.role_id
      WHERE u.id = $1 AND u.is_active = true
      GROUP BY u.id`, [ userId ]);
    if (!result.rows.length) {
      ctx.session = null;
      if (ctx.path.startsWith('/api/')) ctx.throw(401, '登录已失效');
      ctx.redirect('/login');
      return;
    }
    ctx.state.user = result.rows[0];
    ctx.state.roles = result.rows[0].roles || [];
    const projects = await ctx.app.db.query(`
      SELECT DISTINCT p.id, p.code, p.name, p.status, p.is_template, p.source_project_id
      FROM projects p
      WHERE EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND ur.project_id IS NULL
          AND r.code IN ('system_admin', 'audit_admin', 'security_admin')
      ) OR EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND ur.project_id = p.id
          AND r.code IN ('project_admin', 'operator')
      ) OR p.project_manager_id = $1
      ORDER BY p.name, p.code`, [ userId ]);
    ctx.state.projects = projects.rows;
    const rememberedProject = projects.rows.find(project => project.id === result.rows[0].last_project_id);
    const selectedProject = rememberedProject || projects.rows[0] || null;
    if (selectedProject) {
      ctx.session.currentProjectId = selectedProject.id;
      ctx.state.currentProject = selectedProject;
    } else {
      delete ctx.session.currentProjectId;
      ctx.state.currentProject = null;
    }
    await next();
  };
};
