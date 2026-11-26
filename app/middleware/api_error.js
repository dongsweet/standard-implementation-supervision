'use strict';

const FALLBACK_MESSAGES = {
  400: '请求参数有误，请检查后重试',
  401: '登录已失效，请重新登录',
  403: '没有权限或页面已过期，请刷新后重试',
  404: '请求的数据不存在或已被处理',
  409: '数据状态已发生变化，请刷新后重试',
  500: '服务器处理失败，请稍后重试',
};

module.exports = () => async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    if (!ctx.path.startsWith('/api/')) throw error;
    const status = Number(error.status || error.statusCode) || 500;
    const message = status >= 500
      ? FALLBACK_MESSAGES[500]
      : String(error.message || '').trim() || FALLBACK_MESSAGES[status] || '请求处理失败';
    ctx.status = status;
    ctx.type = 'application/json';
    ctx.body = { message };
  }
};
