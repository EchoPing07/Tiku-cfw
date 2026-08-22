import type { Env } from './types/env';
import { refreshCorsConfig, applyCors } from './utils/cors';
import { json } from './utils/response';
import { healthHandler } from './api/health';
import { searchHandler } from './api/search';
import { shareOcsHandler } from './api/share';
import { adminLoginHandler, adminVerifyHandler } from './admin/auth';
import { dashboardHandler } from './admin/dashboard';
import { debugSearchHandler } from './admin/debug';
import { questionsHandler } from './admin/questions';
import { keysHandler } from './admin/keys';
import { channelsHandler } from './admin/channels';
import { settingsHandler } from './admin/settings';
import { logsHandler } from './admin/logs';

/** 路由分发（不含 CORS，由顶层 applyCors 统一注入） */
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // OPTIONS 预检
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  try {
    // ===== 公开 API =====
    if (path === '/api/health') {
      return await healthHandler(request, env);
    }

    // 免登录 OCS 配置分享（令牌鉴权，无需登录）
    if (path.startsWith('/api/share/')) {
      return await shareOcsHandler(request, env, path);
    }

    if (path === '/api/search') {
      return await searchHandler(request, env);
    }

    // ===== 管理后台 API =====
    if (path === '/api/admin/login') {
      return await adminLoginHandler(request, env);
    }

    if (path === '/api/admin/verify') {
      return await adminVerifyHandler(request, env);
    }

    if (path === '/api/admin/dashboard') {
      return await dashboardHandler(request, env);
    }

    if (path.startsWith('/api/admin/questions')) {
      return await questionsHandler(request, env, path);
    }

    if (path.startsWith('/api/admin/keys')) {
      return await keysHandler(request, env, path);
    }

    if (path.startsWith('/api/admin/channels') || path.startsWith('/api/admin/channel-keys')) {
      return await channelsHandler(request, env, path);
    }

    if (path.startsWith('/api/admin/settings')) {
      return settingsHandler(request, env, path);
    }

    // 调试搜题（管理面板搜题测试页）
    if (path === '/api/admin/debug/search') {
      return debugSearchHandler(request, env);
    }

    if (path.startsWith('/api/admin/logs')) {
      return await logsHandler(request, env, path);
    }

    // ===== 前端面板 =====
    if (!path.startsWith('/api/')) {
      // 静态资源从 ASSETS 绑定获取
      return env.ASSETS.fetch(request);
    }

    return json({ code: -1, msg: '接口不存在' }, 404);
  } catch (err) {
    console.error('Unhandled error:', err);
    const errMsg = err instanceof Error ? err.message : '服务器内部错误';
    return json({ code: -1, msg: errMsg }, 500);
  }
}

/** 按设置清理过期搜索日志（由定时任务触发） */
async function purgeOldLogs(env: Env): Promise<void> {
  let days = 0;
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'log_retention_days'").first<{ value: string }>();
    days = parseInt(row?.value || '0', 10) || 0;
  } catch { /* 默认不清理 */ }
  if (days > 0) {
    await env.DB.prepare("DELETE FROM search_logs WHERE created_at < datetime('now', ?)").bind(`-${days} days`).run();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 刷新 CORS 配置（带缓存）
    await refreshCorsConfig(env.DB);

    let res: Response;
    try {
      res = await route(request, env);
    } catch (err) {
      console.error('Unhandled error:', err);
      const errMsg = err instanceof Error ? err.message : '服务器内部错误';
      res = json({ code: -1, msg: errMsg }, 500);
    }
    // 统一注入动态 CORS 头（依据请求 Origin 与配置的 cors_origins）
    return applyCors(request, res);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(purgeOldLogs(env));
  },
};
