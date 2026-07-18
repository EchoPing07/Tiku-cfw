import type { Env } from '../types/env';
import { json, error, options } from '../utils/response';
import { requireAuth } from '../auth/middleware';

/** 搜索日志路由 */
export async function logsHandler(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method === 'OPTIONS') return options();

  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  if (path === '/api/admin/logs') {
    if (request.method === 'GET') return listLogs(request, env);
    if (request.method === 'DELETE') return clearLogs(request, env);
    return error('不支持的方法', 405);
  }

  return error('接口不存在', 404);
}

/** 日志列表 */
async function listLogs(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const size = Math.min(100, Math.max(1, parseInt(url.searchParams.get('size') || '20', 10)));
  const found = url.searchParams.get('found');
  const fromCache = url.searchParams.get('from_cache');
  const offset = (page - 1) * size;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (found !== null && found !== '') {
    conditions.push('found = ?');
    params.push(found === '1' || found === 'true' ? 1 : 0);
  }
  if (fromCache !== null && fromCache !== '') {
    conditions.push('from_cache = ?');
    params.push(fromCache === '1' || fromCache === 'true' ? 1 : 0);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // 总数
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM search_logs ${where}`
  ).bind(...params).first<{ count: number }>();

  // 列表
  const listResult = await env.DB.prepare(
    `SELECT id, question, found, from_cache, answer, ai_channel, ai_model, duration_ms, error, created_at, ai_request, ai_response
     FROM search_logs ${where}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(...params, size, offset).all();

  return json({
    total: countRow?.count || 0,
    page,
    size,
    data: listResult.results || [],
  });
}

/** 清空日志 */
async function clearLogs(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const daysStr = url.searchParams.get('days');

  if (daysStr) {
    // 按天数清理
    const days = parseInt(daysStr, 10);
    await env.DB.prepare(
      `DELETE FROM search_logs WHERE created_at < datetime('now', ?)`
    ).bind(`-${days} days`).run();
    return json({ msg: `已清理 ${days} 天前的日志` });
  }

  // 全部清空
  await env.DB.prepare('DELETE FROM search_logs').run();
  return json({ msg: '日志已清空' });
}
