import type { Env } from '../types/env';
import { json, error, options } from '../utils/response';
import { requireAuth } from '../auth/middleware';
import { uuid } from '../utils/id';

/** AI 渠道管理路由 */
export async function channelsHandler(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method === 'OPTIONS') return options();

  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  // /api/admin/channels - 渠道列表/创建
  if (path === '/api/admin/channels') {
    if (request.method === 'GET') return listChannels(env);
    if (request.method === 'POST') return createChannel(request, env);
    return error('不支持的方法', 405);
  }

  // /api/admin/channels/:id - 渠道详情/编辑/删除
  const channelMatch = path.match(/^\/api\/admin\/channels\/([^/]+)$/);
  if (channelMatch) {
    const id = channelMatch[1];
    if (request.method === 'GET') return getChannel(env, id);
    if (request.method === 'PUT') return updateChannel(request, env, id);
    if (request.method === 'DELETE') return deleteChannel(env, id);
    return error('不支持的方法', 405);
  }

  // /api/admin/channels/:id/keys - 渠道下密钥列表/创建
  const channelKeysMatch = path.match(/^\/api\/admin\/channels\/([^/]+)\/keys$/);
  if (channelKeysMatch) {
    const channelId = channelKeysMatch[1];
    if (request.method === 'GET') return listChannelKeys(env, channelId);
    if (request.method === 'POST') return createChannelKey(request, env, channelId);
    return error('不支持的方法', 405);
  }

  // /api/admin/channel-keys/:id - 密钥编辑/删除/重置
  const keyMatch = path.match(/^\/api\/admin\/channel-keys\/([^/]+)$/);
  if (keyMatch) {
    const id = keyMatch[1];
    if (request.method === 'PUT') return updateChannelKey(request, env, id);
    if (request.method === 'DELETE') return deleteChannelKey(env, id);
    return error('不支持的方法', 405);
  }

  // /api/admin/channel-keys/:id/reset - 重置失败计数
  const resetMatch = path.match(/^\/api\/admin\/channel-keys\/([^/]+)\/reset$/);
  if (resetMatch) {
    const id = resetMatch[1];
    if (request.method === 'POST') return resetChannelKey(env, id);
    return error('不支持的方法', 405);
  }

  return error('接口不存在', 404);
}

// ============ 渠道 CRUD ============

async function listChannels(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT c.*, COUNT(k.id) as total_keys,
       SUM(CASE WHEN k.enabled = 1 THEN 1 ELSE 0 END) as healthy_keys
     FROM ai_channels c
     LEFT JOIN ai_channel_keys k ON k.channel_id = c.id
     GROUP BY c.id
     ORDER BY c.weight DESC, c.created_at ASC`
  ).all();

  return json({ data: result.results || [] });
}

async function getChannel(env: Env, id: string): Promise<Response> {
  const channel = await env.DB.prepare('SELECT * FROM ai_channels WHERE id = ?').bind(id).first();
  if (!channel) return error('渠道不存在', 404);
  const keys = await env.DB.prepare('SELECT * FROM ai_channel_keys WHERE channel_id = ?').bind(id).all();
  return json({ ...channel, keys: keys.results || [] });
}

async function createChannel(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    name: string;
    type: string;
    base_url: string;
    model: string;
    weight?: number;
    temperature?: number;
    max_tokens?: number;
  };

  if (!body.name || !body.type || !body.base_url || !body.model) {
    return error('缺少必填字段');
  }

  if (!['text', 'vision'].includes(body.type)) {
    return error('类型必须为 text 或 vision');
  }

  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO ai_channels (id, name, type, base_url, model, weight, temperature, max_tokens, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).bind(
    id, body.name, body.type, body.base_url, body.model,
    body.weight || 1, body.temperature ?? 0.3, body.max_tokens || 2000
  ).run();

  return json({ id, msg: '创建成功' });
}

async function updateChannel(request: Request, env: Env, id: string): Promise<Response> {
  const body = await request.json() as {
    name?: string;
    type?: string;
    base_url?: string;
    model?: string;
    weight?: number;
    temperature?: number;
    max_tokens?: number;
    enabled?: number;
  };

  const existing = await env.DB.prepare('SELECT id FROM ai_channels WHERE id = ?').bind(id).first();
  if (!existing) return error('渠道不存在', 404);

  await env.DB.prepare(
    `UPDATE ai_channels SET
       name = ?, type = ?, base_url = ?, model = ?,
       weight = ?, temperature = ?, max_tokens = ?, enabled = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    body.name || '', body.type || 'text', body.base_url || '', body.model || '',
    body.weight ?? 1, body.temperature ?? 0.3, body.max_tokens || 2000,
    body.enabled ?? 1, id
  ).run();

  return json({ msg: '更新成功' });
}

async function deleteChannel(env: Env, id: string): Promise<Response> {
  // 删除渠道和关联的密钥（CASCADE）
  await env.DB.prepare('DELETE FROM ai_channel_keys WHERE channel_id = ?').bind(id).run();
  const result = await env.DB.prepare('DELETE FROM ai_channels WHERE id = ?').bind(id).run();
  if (!result.meta.changes) return error('渠道不存在', 404);
  return json({ msg: '删除成功' });
}

// ============ 渠道密钥 CRUD ============

async function listChannelKeys(env: Env, channelId: string): Promise<Response> {
  if (channelId === 'all') {
    // 返回所有渠道密钥，带渠道名
    const result = await env.DB.prepare(
      `SELECT k.*, c.name as channel_name
       FROM ai_channel_keys k
       LEFT JOIN ai_channels c ON c.id = k.channel_id
       ORDER BY k.created_at ASC`
    ).all();
    return json({ data: result.results || [] });
  }
  const result = await env.DB.prepare(
    'SELECT * FROM ai_channel_keys WHERE channel_id = ? ORDER BY created_at ASC'
  ).bind(channelId).all();
  return json({ data: result.results || [] });
}

async function createChannelKey(request: Request, env: Env, channelId: string): Promise<Response> {
  const body = await request.json() as {
    api_key: string;
    name?: string;
  };

  if (!body.api_key) return error('API Key 不能为空');

  // 检查渠道是否存在
  const channel = await env.DB.prepare('SELECT id FROM ai_channels WHERE id = ?').bind(channelId).first();
  if (!channel) return error('渠道不存在', 404);

  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO ai_channel_keys (id, channel_id, api_key, name, enabled, use_count, fail_count) VALUES (?, ?, ?, ?, 1, 0, 0)'
  ).bind(id, channelId, body.api_key, body.name || '').run();

  return json({ id, msg: '创建成功' });
}

async function updateChannelKey(request: Request, env: Env, id: string): Promise<Response> {
  const body = await request.json() as {
    api_key?: string;
    name?: string;
    enabled?: number;
  };

  const existing = await env.DB.prepare('SELECT id FROM ai_channel_keys WHERE id = ?').bind(id).first();
  if (!existing) return error('密钥不存在', 404);

  await env.DB.prepare(
    'UPDATE ai_channel_keys SET api_key = ?, name = ?, enabled = ? WHERE id = ?'
  ).bind(body.api_key || '', body.name || '', body.enabled ?? 1, id).run();

  return json({ msg: '更新成功' });
}

async function deleteChannelKey(env: Env, id: string): Promise<Response> {
  const result = await env.DB.prepare('DELETE FROM ai_channel_keys WHERE id = ?').bind(id).run();
  if (!result.meta.changes) return error('密钥不存在', 404);
  return json({ msg: '删除成功' });
}

async function resetChannelKey(env: Env, id: string): Promise<Response> {
  const existing = await env.DB.prepare('SELECT id FROM ai_channel_keys WHERE id = ?').bind(id).first();
  if (!existing) return error('密钥不存在', 404);

  await env.DB.prepare(
    'UPDATE ai_channel_keys SET fail_count = 0, enabled = 1 WHERE id = ?'
  ).bind(id).run();

  return json({ msg: '已重置' });
}
