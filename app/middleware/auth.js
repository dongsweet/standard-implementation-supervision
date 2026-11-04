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
      SELECT u.id, u.username, u.display_name,
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
    await next();
  };
};
