import type { Env } from '../types/env';
import { json, error, options } from '../utils/response';
import { requireAuth } from '../auth/middleware';
import { uuid, generateApiKey } from '../utils/id';
import { parseJsonBody } from '../utils/request';

/** API 密钥管理路由 */
export async function keysHandler(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method === 'OPTIONS') return options();

  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  // /api/admin/keys - 列表/创建
  if (path === '/api/admin/keys') {
    if (request.method === 'GET') return listKeys(env);
    if (request.method === 'POST') return createKey(request, env);
    return error('不支持的方法', 405);
  }

  // /api/admin/keys/:id
  const idMatch = path.match(/^\/api\/admin\/keys\/(.+)$/);
  if (idMatch) {
    const id = idMatch[1];
    if (request.method === 'PUT') return updateKey(request, env, id);
    if (request.method === 'DELETE') return deleteKey(env, id);
    return error('不支持的方法', 405);
  }

  return error('接口不存在', 404);
}

/** 密钥列表 */
async function listKeys(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT id, key, name, enabled, expires_at, use_count, last_used, created_at
     FROM api_keys ORDER BY created_at DESC`
  ).all();

  return json({ data: result.results || [] });
}

/** 创建密钥 */
async function createKey(request: Request, env: Env): Promise<Response> {
  const parsed = await parseJsonBody<{ name?: string; expires_at?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const id = uuid();
  const key = generateApiKey();

  await env.DB.prepare(
    `INSERT INTO api_keys (id, key, name, enabled, expires_at)
     VALUES (?, ?, ?, 1, ?)`
  ).bind(id, key, body.name || '', body.expires_at || null).run();

  return json({ id, key, msg: '创建成功' });
}

/** 更新密钥 */
async function updateKey(request: Request, env: Env, id: string): Promise<Response> {
  const parsed = await parseJsonBody<{ name?: string; enabled?: number; expires_at?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const existing = await env.DB.prepare('SELECT id FROM api_keys WHERE id = ?').bind(id).first();
  if (!existing) return error('密钥不存在', 404);

  // 按字段存在性更新，允许显式置空 expires_at
  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name); }
  if (body.enabled !== undefined) { sets.push('enabled = ?'); params.push(body.enabled); }
  if (body.expires_at !== undefined) { sets.push('expires_at = ?'); params.push(body.expires_at || null); }
  if (sets.length === 0) return json({ msg: '无更新' });
  params.push(id);
  await env.DB.prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();

  return json({ msg: '更新成功' });
}

/** 删除密钥 */
async function deleteKey(env: Env, id: string): Promise<Response> {
  const result = await env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
  if (!result.meta.changes) return error('密钥不存在', 404);
  return json({ msg: '删除成功' });
}
