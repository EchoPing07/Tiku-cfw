import type { Env } from '../types/env';
import { json, error, options } from '../utils/response';
import { requireAuth } from '../auth/middleware';
import { uuid, generateApiKey, randomHex } from '../utils/id';
import { parseJsonBody } from '../utils/request';
import { buildOCSConfig } from '../utils/ocs';
import { validateExpiry } from '../utils/expiry';

/** 题库密钥管理路由 */
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

  // /api/admin/keys/:id/ocs-config - 获取 OCS 配置（需在 :id 通配之前匹配）
  const ocsMatch = path.match(/^\/api\/admin\/keys\/([^/]+)\/ocs-config$/);
  if (ocsMatch) {
    if (request.method === 'GET') return getKeyOcsConfig(request, env, ocsMatch[1]);
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
  let rows: Record<string, unknown>[];
  try {
    const result = await env.DB.prepare(
      `SELECT id, key, name, enabled, expires_at, use_count, last_used, created_at, share_enabled, share_token
       FROM api_keys ORDER BY created_at DESC`
    ).all();
    rows = result.results || [];
  } catch (err) {
    // 仅当 0004 迁移未执行（share_enabled 列缺失）时降级为旧查询；
    // 其他错误如实抛出，避免"保存成功但列表误显示关闭"
    if (!(err instanceof Error && /no such column/i.test(err.message))) throw err;
    const result = await env.DB.prepare(
      `SELECT id, key, name, enabled, expires_at, use_count, last_used, created_at
       FROM api_keys ORDER BY created_at DESC`
    ).all();
    rows = (result.results || []).map(r => ({ ...r, share_enabled: 0, share_token: null }));
  }

  return json({ data: rows });
}

/** 创建密钥 */
async function createKey(request: Request, env: Env): Promise<Response> {
  const parsed = await parseJsonBody<{ name?: string; expires_at?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // 过期时间格式校验，脏值不再静默变成"永不过期"
  const exp = validateExpiry(body.expires_at);
  if (!exp.valid) return error('过期时间格式无效，应为 YYYY-MM-DD');

  const id = uuid();
  const key = generateApiKey();

  await env.DB.prepare(
    `INSERT INTO api_keys (id, key, name, enabled, expires_at)
     VALUES (?, ?, ?, 1, ?)`
  ).bind(id, key, body.name || '', exp.value).run();

  return json({ id, key, msg: '创建成功' });
}

/** 更新密钥 */
async function updateKey(request: Request, env: Env, id: string): Promise<Response> {
  const parsed = await parseJsonBody<{ name?: string; enabled?: number; expires_at?: string; share_enabled?: number }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const existing = await env.DB.prepare('SELECT id FROM api_keys WHERE id = ?').bind(id).first();
  if (!existing) return error('密钥不存在', 404);

  // 按字段存在性更新，允许显式置空 expires_at
  const sets: string[] = [];
  const params: unknown[] = [];
  let shareEnabled: number | undefined;
  let shareToken: string | null | undefined;
  if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name); }
  if (body.enabled !== undefined) { sets.push('enabled = ?'); params.push(body.enabled); }
  if (body.expires_at !== undefined) {
    // 格式校验：空串/null 表示显式清除（永不过期），非法格式直接拒绝
    const exp = validateExpiry(body.expires_at);
    if (!exp.valid) return error('过期时间格式无效，应为 YYYY-MM-DD');
    sets.push('expires_at = ?'); params.push(exp.value);
  }
  // 分享开关：开启时生成全新令牌，关闭时清空令牌使链接立即失效
  // 严格判定：仅数值 1 视为开启，避免 "0"/"false"/true 等宽松真值误开启
  if (body.share_enabled !== undefined) {
    shareEnabled = Number(body.share_enabled) === 1 ? 1 : 0;
    shareToken = shareEnabled ? 'sh_' + randomHex(16) : null;
    sets.push('share_enabled = ?', 'share_token = ?');
    params.push(shareEnabled, shareToken);
  }
  if (sets.length === 0) return json({ msg: '无更新' });
  params.push(id);
  try {
    await env.DB.prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
  } catch (err) {
    // 分享字段依赖迁移 0004：仅当 share_enabled 列缺失时提示迁移，其他错误如实抛出
    if (body.share_enabled !== undefined && err instanceof Error && /no such column/i.test(err.message)) {
      return error('分享功能需要先执行迁移：npm run db:migrate:share');
    }
    throw err;
  }

  // 返回新生成的分享状态/令牌，前端可即时更新 UI
  const share: Record<string, unknown> = {};
  if (body.share_enabled !== undefined) {
    share.share_enabled = shareEnabled;
    share.share_token = shareToken;
  }
  return json({ msg: '更新成功', ...share });
}

/** 获取某密钥的 OCS 配置（管理面板复制用，与分享页输出一致） */
async function getKeyOcsConfig(request: Request, env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT k.key, s.value AS site_name
     FROM api_keys k LEFT JOIN settings s ON s.key = 'site_name'
     WHERE k.id = ?`
  ).bind(id).first<{ key: string; site_name: string | null }>();
  if (!row) return error('密钥不存在', 404);

  const config = buildOCSConfig({
    siteName: row.site_name || 'Tiku-cfw',
    origin: new URL(request.url).origin,
    apiKey: row.key,
  });
  // 响应含 API Key，禁止缓存
  return new Response(JSON.stringify({ config, msg: '成功' }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** 删除密钥 */
async function deleteKey(env: Env, id: string): Promise<Response> {
  const result = await env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
  if (!result.meta.changes) return error('密钥不存在', 404);
  return json({ msg: '删除成功' });
}
