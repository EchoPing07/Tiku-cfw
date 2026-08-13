import type { Env } from '../types/env';
import { error } from '../utils/response';
import { isExpired } from '../utils/expiry';
import { buildOCSConfig } from '../utils/ocs';

/**
 * 免登录分享接口：按分享令牌返回 OCS 配置（含 API Key，令牌即密钥）。
 * 仅在密钥开启分享、处于启用状态且未过期时有效。
 */
export async function shareOcsHandler(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== 'GET') return error('仅支持 GET 请求', 405);

  const match = path.match(/^\/api\/share\/ocs\/([^/]+)$/);
  if (!match) return error('链接无效或已关闭', 404);

  const row = await env.DB.prepare(
    `SELECT k.key, k.enabled, k.expires_at, s.value AS site_name
     FROM api_keys k LEFT JOIN settings s ON s.key = 'site_name'
     WHERE k.share_token = ? AND k.share_enabled = 1`
  ).bind(match[1]).first<{ key: string; enabled: number; expires_at: string | null; site_name: string | null }>();

  // 令牌不存在或分享已关闭
  if (!row) return error('链接无效或已关闭', 404);
  // 密钥被禁用或过期时分享链接同步失效（与搜题鉴权口径一致）
  if (!row.enabled) return error('链接无效或已关闭', 404);
  if (isExpired(row.expires_at)) return error('链接无效或已关闭', 404);

  const config = buildOCSConfig({
    siteName: row.site_name || 'Tiku-cfw',
    origin: new URL(request.url).origin,
    apiKey: row.key,
  });

  // 直接返回配置 JSON 本身（非 {code,...} 包装），并禁止缓存（含密钥的响应）
  return new Response(config, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
