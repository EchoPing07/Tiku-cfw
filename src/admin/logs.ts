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

/** search_logs 列级别（对应迁移进度），按 isolate 探测一次并缓存，避免每次查询先经历失败 */
type LogsSchema = 'full' | 'debug' | 'base';
let logsSchema: LogsSchema | null = null;

const isNoSuchColumn = (err: unknown): boolean => err instanceof Error && /no such column/i.test(err.message);

const LOG_COLUMNS: Record<LogsSchema, string> = {
  full: 'id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, error, created_at, ai_request, ai_response, prompt_tokens, completion_tokens, total_tokens',
  debug: 'id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, error, created_at, ai_request, ai_response',
  base: 'id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, error, created_at',
};

async function selectLogsPage(
  env: Env,
  where: string,
  params: unknown[],
  size: number,
  offset: number
): Promise<D1Result<Record<string, unknown>>> {
  const order: LogsSchema[] = logsSchema ? [logsSchema] : ['full', 'debug', 'base'];
  let lastErr: unknown;
  for (const s of order) {
    try {
      const r = await env.DB.prepare(
        `SELECT ${LOG_COLUMNS[s]} FROM search_logs ${where}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).bind(...params, size, offset).all<Record<string, unknown>>();
      logsSchema = s;
      return r;
    } catch (err) {
      if (!isNoSuchColumn(err)) throw err;
      lastErr = err;
      logsSchema = null; // 缓存失效（如表结构变化），退回逐级探测
    }
  }
  throw lastErr;
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

  // 列表（含 AI 请求/响应原始内容与 Token 用量，方便排查；列级别按迁移状态自动降级）
  const listResult = await selectLogsPage(env, where, params, size, offset);

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
    if (!Number.isFinite(days) || days < 0) return error('days 无效');
    await env.DB.prepare(
      `DELETE FROM search_logs WHERE created_at < datetime('now', ?)`
    ).bind(`-${days} days`).run();
    return json({ msg: `已清理 ${days} 天前的日志` });
  }

  // 全部清空
  await env.DB.prepare('DELETE FROM search_logs').run();
  return json({ msg: '日志已清空' });
}
