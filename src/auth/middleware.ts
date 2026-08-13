import type { Env } from '../types/env';
import { verifyJWT, extractBearer } from './jwt';
import { unauthorized } from '../utils/response';
import { isExpired } from '../utils/expiry';

/** 管理员认证中间件，验证通过返回 null，否则返回 401 响应 */
export async function requireAuth(request: Request, env: Env): Promise<Response | null> {
  // OPTIONS 预检交由 index.ts 顶层 applyCors 统一处理
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
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
  // 仅接受 Authorization: Bearer <key>，避免 key 泄漏到 URL/访问日志/Referer
  const apiKey = extractBearer(request);

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

  if (isExpired(row.expires_at)) {
    return { ok: false, response: unauthorized('API Key 已过期') };
  }

  return { ok: true, data: { id: row.id, key: row.key } };
}
