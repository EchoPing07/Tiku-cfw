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

  // /api/admin/logs/:id - 单条详情（含完整信封与尝试链）
  const detailMatch = path.match(/^\/api\/admin\/logs\/([^/]+)$/);
  if (detailMatch) {
    if (request.method === 'GET') return getLogDetail(env, detailMatch[1]);
    return error('不支持的方法', 405);
  }

  return error('接口不存在', 404);
}

/**
 * search_logs 列级别（对应迁移进度），按 isolate 探测一次并缓存，避免每次查询先经历失败。
 * 列表只取轻量列（大字段仅取“是否有内容”标记），详情接口才拉全文。
 */
type LogsSchema = 'trace' | 'full' | 'debug' | 'base';
let logsSchema: LogsSchema | null = null;

const isNoSuchColumn = (err: unknown): boolean => err instanceof Error && /no such column/i.test(err.message);

/** 列表用列（轻量：不带 ai_request/ai_response/attempts 全文） */
const LIST_COLUMNS: Record<LogsSchema, string> = {
  trace: `id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, error, error_type, http_status, created_at, prompt_tokens, completion_tokens, total_tokens,
          (ai_request IS NOT NULL AND ai_request != '') AS has_debug`,
  full: 'id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, error, created_at, prompt_tokens, completion_tokens, total_tokens, 0 AS has_debug',
  debug: 'id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, error, created_at, 0 AS prompt_tokens, 0 AS completion_tokens, 0 AS total_tokens, 0 AS has_debug',
  base: 'id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, error, created_at, 0 AS prompt_tokens, 0 AS completion_tokens, 0 AS total_tokens, 0 AS has_debug',
};

/** 详情用列（全量） */
const DETAIL_COLUMNS: Record<LogsSchema, string> = {
  trace: 'id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, error, error_type, http_status, created_at, ai_request, ai_response, prompt_tokens, completion_tokens, total_tokens, attempts',
  full: 'id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, error, created_at, ai_request, ai_response, prompt_tokens, completion_tokens, total_tokens, NULL AS error_type, NULL AS http_status, NULL AS attempts',
  debug: 'id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, error, created_at, ai_request, ai_response, 0 AS prompt_tokens, 0 AS completion_tokens, 0 AS total_tokens, NULL AS error_type, NULL AS http_status, NULL AS attempts',
  base: 'id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, error, created_at, NULL AS ai_request, NULL AS ai_response, 0 AS prompt_tokens, 0 AS completion_tokens, 0 AS total_tokens, NULL AS error_type, NULL AS http_status, NULL AS attempts',
};

/** 探测列级别（trace → full → debug → base；ai_request 为各级共有基础列，先探） */
async function detectLogsSchema(env: Env): Promise<LogsSchema> {
  if (logsSchema) return logsSchema;
  try {
    await env.DB.prepare('SELECT ai_request, ai_response FROM search_logs LIMIT 1').first();
  } catch (err) {
    if (!isNoSuchColumn(err)) throw err;
    return (logsSchema = 'base');
  }
  try {
    await env.DB.prepare('SELECT prompt_tokens, completion_tokens, total_tokens FROM search_logs LIMIT 1').first();
  } catch (err) {
    if (!isNoSuchColumn(err)) throw err;
    return (logsSchema = 'debug');
  }
  try {
    await env.DB.prepare('SELECT error_type, http_status, attempts FROM search_logs LIMIT 1').first();
  } catch (err) {
    if (!isNoSuchColumn(err)) throw err;
    return (logsSchema = 'full');
  }
  return (logsSchema = 'trace');
}

async function selectLogsPage(
  env: Env,
  where: string,
  params: unknown[],
  size: number,
  offset: number
): Promise<D1Result<Record<string, unknown>>> {
  const order: LogsSchema[] = logsSchema ? [logsSchema] : ['trace', 'full', 'debug', 'base'];
  let lastErr: unknown;
  for (const s of order) {
    try {
      const r = await env.DB.prepare(
        `SELECT ${LIST_COLUMNS[s]} FROM search_logs ${where}
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

/** 日志列表（轻量列；error_type 筛选需 trace 级，未迁移时忽略该参数） */
async function listLogs(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const size = Math.min(100, Math.max(1, parseInt(url.searchParams.get('size') || '20', 10)));
  const found = url.searchParams.get('found');
  const fromCache = url.searchParams.get('from_cache');
  const errorType = url.searchParams.get('error_type');
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

  // error_type 筛选仅 trace 级可用；探测失败级别则忽略
  if (errorType) {
    const schema = await detectLogsSchema(env).catch(() => 'base' as LogsSchema);
    if (schema === 'trace') {
      conditions.push('error_type = ?');
      params.push(errorType);
    }
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // 总数
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM search_logs ${where}`
  ).bind(...params).first<{ count: number }>();

  // 列表（轻量列；has_debug 标记前端据此显示“查看原始请求”入口）
  const listResult = await selectLogsPage(env, where, params, size, offset);

  return json({
    total: countRow?.count || 0,
    page,
    size,
    data: listResult.results || [],
  });
}

/** 单条日志详情（含 AI 请求/响应信封与尝试链全文） */
async function getLogDetail(env: Env, id: string): Promise<Response> {
  const schema = await detectLogsSchema(env).catch(() => 'base' as LogsSchema);
  const row = await env.DB.prepare(
    `SELECT ${DETAIL_COLUMNS[schema]} FROM search_logs WHERE id = ?`
  ).bind(id).first<Record<string, unknown>>();
  if (!row) return error('日志不存在', 404);
  return json({ data: row });
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
