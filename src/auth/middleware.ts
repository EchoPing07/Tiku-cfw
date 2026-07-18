import type { Env } from '../types/env';
import { verifyJWT, extractBearer } from './jwt';
import { unauthorized } from '../utils/response';
import { corsHeaders } from '../utils/cors';

/** 管理员认证中间件，验证通过返回 null，否则返回 401 响应 */
export async function requireAuth(request: Request, env: Env): Promise<Response | null> {
  // OPTIONS 直接放行
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const token = extractBearer(request);
  if (!token) {
    return unauthorized('请先登录');
  }

  const valid = await verifyJWT(token, env);
  if (!valid) {
    return unauthorized('登录已过期，请重新登录');
  }

  return null; // 验证通过
}

/** API Key 鉴权，验证通过返回 { id, key } 对象，否则返回错误响应 */
export async function requireApiKey(request: Request, env: Env): Promise<{ ok: true; data: { id: string; key: string } } | { ok: false; response: Response }> {
  // 从 Header 或 Query 参数获取 API Key
  let apiKey = extractBearer(request);
  if (!apiKey) {
    const url = new URL(request.url);
    apiKey = url.searchParams.get('key');
  }

  if (!apiKey) {
    return { ok: false, response: unauthorized('缺少 API Key') };
  }

  // 查询数据库验证 API Key
  const row = await env.DB.prepare(
    'SELECT id, key, enabled, expires_at FROM api_keys WHERE key = ?'
  ).bind(apiKey).first<{ id: string; key: string; enabled: number; expires_at: string | null }>();

  if (!row) {
    return { ok: false, response: unauthorized('API Key 无效') };
  }

  if (!row.enabled) {
    return { ok: false, response: unauthorized('API Key 已禁用') };
  }

  if (row.expires_at) {
    const expiry = new Date(row.expires_at + 'Z').getTime();
    if (Date.now() > expiry) {
      return { ok: false, response: unauthorized('API Key 已过期') };
    }
  }

  return { ok: true, data: { id: row.id, key: row.key } };
}
