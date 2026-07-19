import type { Env } from './types/env';
import { refreshCorsConfig } from './utils/cors';
import { json, options } from './utils/response';
import { healthHandler } from './api/health';
import { searchHandler } from './api/search';
import { adminLoginHandler, adminVerifyHandler } from './admin/auth';
import { dashboardHandler } from './admin/dashboard';
import { questionsHandler } from './admin/questions';
import { keysHandler } from './admin/keys';
import { channelsHandler } from './admin/channels';
import { settingsHandler } from './admin/settings';
import { logsHandler } from './admin/logs';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 刷新 CORS 配置（带缓存）
    await refreshCorsConfig(env.DB);

    // OPTIONS 预检
    if (method === 'OPTIONS') {
      return options();
    }

    try {
      // ===== 公开 API =====
      if (path === '/api/health') {
        return await healthHandler(request, env);
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
        return await settingsHandler(request, env, path);
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
  },
};


