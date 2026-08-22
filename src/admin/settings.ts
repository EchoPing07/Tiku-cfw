import type { Env } from '../types/env';
import { json, error, options } from '../utils/response';
import { requireAuth } from '../auth/middleware';
import { refreshCorsConfig } from '../utils/cors';
import { parseJsonBody } from '../utils/request';
import { parseTimezoneOffset } from '../utils/timezone';

/** 系统设置路由 */
export async function settingsHandler(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method === 'OPTIONS') return options();

  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  if (path === '/api/admin/settings') {
    if (request.method === 'GET') return getSettings(env);
    if (request.method === 'PUT') return updateSettings(request, env);
    return error('不支持的方法', 405);
  }

  return error('接口不存在', 404);
}

/** 获取所有设置 */
async function getSettings(env: Env): Promise<Response> {
  const result = await env.DB.prepare('SELECT key, value, description FROM settings').all<{
    key: string; value: string; description: string | null
  }>();

  const settings: Record<string, string> = {};
  for (const row of result.results || []) {
    settings[row.key] = row.value;
  }

  return json({ settings, raw: result.results || [] });
}

/** 批量更新设置 */
async function updateSettings(request: Request, env: Env): Promise<Response> {
  const parsed = await parseJsonBody<Record<string, string>>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // 先校验再写入，避免部分写入后因非法值失败
  if (body.timezone_offset !== undefined) {
    const tz = parseTimezoneOffset(body.timezone_offset);
    if (tz === null) return error('timezone_offset 无效（-720~840 分钟）');
    body.timezone_offset = String(tz);
  }

  for (const [key, value] of Object.entries(body)) {
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`
    ).bind(key, value, value).run();
  }

  // 刷新 CORS 缓存
  await refreshCorsConfig(env.DB);

  return json({ msg: '设置已保存' });
}
