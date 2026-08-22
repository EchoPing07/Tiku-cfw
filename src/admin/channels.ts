import type { Env } from '../types/env';
import type { AIChannelRow, AIChannelKeyRow } from '../ai/types';
import { json, error, options } from '../utils/response';
import { requireAuth } from '../auth/middleware';
import { uuid } from '../utils/id';
import { parseJsonBody } from '../utils/request';
import { callOpenAI } from '../ai/openai-client';

/** 模型管理路由（数据库表沿用 ai_channels） */
export async function channelsHandler(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method === 'OPTIONS') return options();

  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  // /api/admin/channels - 模型列表/创建
  if (path === '/api/admin/channels') {
    if (request.method === 'GET') return listChannels(env);
    if (request.method === 'POST') return createChannel(request, env);
    return error('不支持的方法', 405);
  }

  // /api/admin/channels/:id - 模型详情/编辑/删除
  const channelMatch = path.match(/^\/api\/admin\/channels\/([^/]+)$/);
  if (channelMatch) {
    const id = channelMatch[1];
    if (request.method === 'GET') return getChannel(env, id);
    if (request.method === 'PUT') return updateChannel(request, env, id);
    if (request.method === 'DELETE') return deleteChannel(env, id);
    return error('不支持的方法', 405);
  }

  // /api/admin/channels/:id/keys - 模型下 API Key 列表/创建
  const channelKeysMatch = path.match(/^\/api\/admin\/channels\/([^/]+)\/keys$/);
  if (channelKeysMatch) {
    const channelId = channelKeysMatch[1];
    if (request.method === 'GET') return listChannelKeys(env, channelId);
    if (request.method === 'POST') return createChannelKey(request, env, channelId);
    return error('不支持的方法', 405);
  }

  // /api/admin/channels/:id/test - 测试模型连通性
  const testMatch = path.match(/^\/api\/admin\/channels\/([^/]+)\/test$/);
  if (testMatch) {
    if (request.method === 'POST') return testChannelConnection(env, testMatch[1]);
    return error('不支持的方法', 405);
  }

  // /api/admin/channel-keys/:id - API Key 编辑/删除/重置
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

// ============ 模型 CRUD ============

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
  if (!channel) return error('模型不存在', 404);
  const keys = await env.DB.prepare('SELECT * FROM ai_channel_keys WHERE channel_id = ?').bind(id).all();
  return json({ ...channel, keys: keys.results || [] });
}

async function createChannel(request: Request, env: Env): Promise<Response> {
  const parsed = await parseJsonBody<{
    name: string; type: string; base_url: string; model: string;
    weight?: number; temperature?: number; max_tokens?: number;
  }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.name || !body.type || !body.base_url || !body.model) {
    return error('缺少必填字段');
  }
  if (!['text', 'vision'].includes(body.type)) {
    return error('类型必须为 text 或 vision');
  }
  const weight = body.weight ?? 1;
  const temperature = body.temperature ?? 0.3;
  const maxTokens = body.max_tokens ?? 2000;
  if (!Number.isFinite(weight) || weight < 1) return error('weight 必须 >= 1');
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) return error('temperature 必须在 0~2 之间');
  if (!Number.isFinite(maxTokens) || maxTokens < 1) return error('max_tokens 必须 >= 1');

  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO ai_channels (id, name, type, base_url, model, weight, temperature, max_tokens, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).bind(id, body.name, body.type, body.base_url, body.model, weight, temperature, maxTokens).run();

  return json({ id, msg: '创建成功' });
}

async function updateChannel(request: Request, env: Env, id: string): Promise<Response> {
  const parsed = await parseJsonBody<{
    name?: string; type?: string; base_url?: string; model?: string;
    weight?: number; temperature?: number; max_tokens?: number; enabled?: number;
  }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const existing = await env.DB.prepare('SELECT id FROM ai_channels WHERE id = ?').bind(id).first();
  if (!existing) return error('模型不存在', 404);

  if (body.type !== undefined && !['text', 'vision'].includes(body.type)) return error('类型必须为 text 或 vision');
  if (body.weight !== undefined && (!Number.isFinite(body.weight) || body.weight < 1)) return error('weight 必须 >= 1');
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) return error('temperature 必须在 0~2 之间');
  if (body.max_tokens !== undefined && (!Number.isFinite(body.max_tokens) || body.max_tokens < 1)) return error('max_tokens 必须 >= 1');

  // 按字段存在性更新，避免部分 PUT 清空字段
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];
  if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name); }
  if (body.type !== undefined) { sets.push('type = ?'); params.push(body.type); }
  if (body.base_url !== undefined) { sets.push('base_url = ?'); params.push(body.base_url); }
  if (body.model !== undefined) { sets.push('model = ?'); params.push(body.model); }
  if (body.weight !== undefined) { sets.push('weight = ?'); params.push(body.weight); }
  if (body.temperature !== undefined) { sets.push('temperature = ?'); params.push(body.temperature); }
  if (body.max_tokens !== undefined) { sets.push('max_tokens = ?'); params.push(body.max_tokens); }
  if (body.enabled !== undefined) { sets.push('enabled = ?'); params.push(body.enabled); }
  params.push(id);

  await env.DB.prepare(`UPDATE ai_channels SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();

  return json({ msg: '更新成功' });
}

async function deleteChannel(env: Env, id: string): Promise<Response> {
  // 删除模型和关联的 API Key（CASCADE）
  await env.DB.prepare('DELETE FROM ai_channel_keys WHERE channel_id = ?').bind(id).run();
  const result = await env.DB.prepare('DELETE FROM ai_channels WHERE id = ?').bind(id).run();
  if (!result.meta.changes) return error('模型不存在', 404);
  return json({ msg: '删除成功' });
}

// ============ 模型 API Key CRUD ============

async function listChannelKeys(env: Env, channelId: string): Promise<Response> {
  if (channelId === 'all') {
    // 返回所有模型的 API Key，带模型名称
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
  const parsed = await parseJsonBody<{ api_key: string; name?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.api_key) return error('API Key 不能为空');

  // 检查模型是否存在
  const channel = await env.DB.prepare('SELECT id FROM ai_channels WHERE id = ?').bind(channelId).first();
  if (!channel) return error('模型不存在', 404);

  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO ai_channel_keys (id, channel_id, api_key, name, enabled, use_count, fail_count) VALUES (?, ?, ?, ?, 1, 0, 0)'
  ).bind(id, channelId, body.api_key, body.name || '').run();

  return json({ id, msg: '创建成功' });
}

async function updateChannelKey(request: Request, env: Env, id: string): Promise<Response> {
  const parsed = await parseJsonBody<{ api_key?: string; name?: string; enabled?: number | boolean }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const existing = await env.DB.prepare('SELECT id FROM ai_channel_keys WHERE id = ?').bind(id).first();
  if (!existing) return error('密钥不存在', 404);

  // 按字段存在性更新，避免部分 PUT 把 api_key 清空或意外改写 enabled
  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.api_key !== undefined) {
    if (typeof body.api_key !== 'string' || !body.api_key.trim()) return error('API Key 不能为空');
    sets.push('api_key = ?'); params.push(body.api_key.trim());
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return error('备注名(name)必须为字符串');
    sets.push('name = ?'); params.push(body.name);
  }
  if (body.enabled !== undefined) {
    const enabled = Number(body.enabled) === 1;
    sets.push('enabled = ?'); params.push(enabled ? 1 : 0);
  }
  if (sets.length === 0) return json({ msg: '无更新' });
  params.push(id);

  await env.DB.prepare(`UPDATE ai_channel_keys SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();

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

// ============ 模型连通性测试 ============

/** 掩码密钥：保留前 6 位与后 4 位 */
function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '****';
  return key.slice(0, 6) + '...' + key.slice(-4);
}

interface KeyTestResult {
  key_id: string;
  name: string;
  masked: string;
  ok: boolean;
  latency_ms: number;
  model: string | null;
  error: string | null;
}

/**
 * 测试模型连通性：对模型下每个 API Key 发一次轻量的真实补全请求（"hi"，1024 token 上限）。
 * 推理模型即使回复为空（思考占满 token 预算）也视为连通正常。
 * 测试通过的 API Key 自动清除失败计数并重新启用（带验证的自愈）；
 * 测试失败不累加 fail_count（人工测试不应触发自动禁用）。
 */
async function testChannelConnection(env: Env, id: string): Promise<Response> {
  const channel = await env.DB.prepare('SELECT * FROM ai_channels WHERE id = ?').bind(id).first<AIChannelRow>();
  if (!channel) return error('模型不存在', 404);

  const keys = await env.DB.prepare(
    'SELECT * FROM ai_channel_keys WHERE channel_id = ? ORDER BY enabled DESC, use_count ASC'
  ).bind(id).all<AIChannelKeyRow>();

  const keyRows = keys.results || [];
  if (keyRows.length === 0) {
    return json({ code: 1, ok: false, msg: '模型下没有 API Key，请先添加', keys: [] });
  }

  // 并行测试所有 API Key，避免串行时多个超时 Key 把总耗时拉到 N×15s
  const results = await Promise.all(keyRows.map(async (k): Promise<KeyTestResult> => {
    const start = Date.now();
    try {
      const r = await callOpenAI({
        messages: [{ role: 'user', content: 'hi' }],
        baseUrl: channel.base_url as string,
        apiKey: k.api_key as string,
        model: channel.model as string,
        temperature: 0,
        maxTokens: 1024,
        timeout: 15,
        allowEmptyContent: true,
      });
      return {
        key_id: k.id, name: k.name || '', masked: maskKey(k.api_key as string),
        ok: true, latency_ms: Date.now() - start, model: r.model, error: null,
      };
    } catch (err) {
      return {
        key_id: k.id, name: k.name || '', masked: maskKey(k.api_key as string),
        ok: false, latency_ms: Date.now() - start, model: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }));

  // 测试通过的 API Key 自愈：清除失败计数并重新启用（带验证的重置）
  await Promise.all(
    results.filter(r => r.ok).map(r =>
      env.DB.prepare('UPDATE ai_channel_keys SET fail_count = 0, enabled = 1 WHERE id = ?').bind(r.key_id).run()
    )
  );

  const ok = results.some(r => r.ok);
  return json({
    code: 1,
    ok,
    msg: ok ? '连接正常' : '全部 API Key 不可用',
    keys: results,
  });
}
