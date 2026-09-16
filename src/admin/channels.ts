import type { Env } from '../types/env';
import type { AIChannelRow } from '../ai/types';
import { json, error, options } from '../utils/response';
import { requireAuth } from '../auth/middleware';
import { uuid } from '../utils/id';
import { parseJsonBody } from '../utils/request';
import { callOpenAI } from '../ai/openai-client';

/** 模型管理路由（模型条目化：一个条目 = 端点 + 模型 + 单个 API Key + 权重） */
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

  // /api/admin/channels/:id/test - 测试模型连通性
  const testMatch = path.match(/^\/api\/admin\/channels\/([^/]+)\/test$/);
  if (testMatch) {
    if (request.method === 'POST') return testChannelConnection(env, testMatch[1]);
    return error('不支持的方法', 405);
  }

  // /api/admin/channels/:id/recover - 立即解除熔断冷却
  const recoverMatch = path.match(/^\/api\/admin\/channels\/([^/]+)\/recover$/);
  if (recoverMatch) {
    if (request.method === 'POST') return recoverChannel(env, recoverMatch[1]);
    return error('不支持的方法', 405);
  }

  return error('接口不存在', 404);
}

// ============ 模型 CRUD ============

async function listChannels(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT * FROM ai_channels
     ORDER BY weight DESC, created_at ASC`
  ).all<AIChannelRow>();
  return json({ data: result.results || [] });
}

async function getChannel(env: Env, id: string): Promise<Response> {
  const channel = await env.DB.prepare('SELECT * FROM ai_channels WHERE id = ?').bind(id).first<AIChannelRow>();
  if (!channel) return error('模型不存在', 404);
  return json({ ...channel });
}

interface ChannelBody {
  name?: string;
  type?: string;
  base_url?: string;
  model?: string;
  api_key?: string;
  weight?: number;
  temperature?: number;
  max_tokens?: number;
  enabled?: number;
}

/** 公共字段校验（创建/更新共用） */
function validateChannelFields(body: ChannelBody): string | null {
  if (body.type !== undefined && !['text', 'vision'].includes(body.type)) return '类型必须为 text 或 vision';
  if (body.weight !== undefined && (!Number.isFinite(body.weight) || body.weight < 1)) return 'weight 必须 >= 1';
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) return 'temperature 必须在 0~2 之间';
  if (body.max_tokens !== undefined && (!Number.isFinite(body.max_tokens) || body.max_tokens < 1)) return 'max_tokens 必须 >= 1';
  if (body.api_key !== undefined && (typeof body.api_key !== 'string' || !body.api_key.trim())) return 'API Key 不能为空';
  return null;
}

async function createChannel(request: Request, env: Env): Promise<Response> {
  const parsed = await parseJsonBody<ChannelBody>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.name || !body.type || !body.base_url || !body.model) {
    return error('缺少必填字段');
  }
  if (!body.api_key || !body.api_key.trim()) {
    return error('API Key 不能为空（每个模型条目自带一个 Key）');
  }
  const invalid = validateChannelFields(body);
  if (invalid) return error(invalid);

  const weight = body.weight ?? 1;
  const temperature = body.temperature ?? 0.3;
  const maxTokens = body.max_tokens ?? 2000;

  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO ai_channels (id, name, type, base_url, model, api_key, weight, temperature, max_tokens, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).bind(id, body.name, body.type, body.base_url, body.model, body.api_key.trim(), weight, temperature, maxTokens).run();

  return json({ id, msg: '创建成功' });
}

async function updateChannel(request: Request, env: Env, id: string): Promise<Response> {
  const parsed = await parseJsonBody<ChannelBody>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const existing = await env.DB.prepare('SELECT id FROM ai_channels WHERE id = ?').bind(id).first();
  if (!existing) return error('模型不存在', 404);

  const invalid = validateChannelFields(body);
  if (invalid) return error(invalid);

  // 按字段存在性更新，避免部分 PUT 清空字段
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];
  if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name); }
  if (body.type !== undefined) { sets.push('type = ?'); params.push(body.type); }
  if (body.base_url !== undefined) { sets.push('base_url = ?'); params.push(body.base_url); }
  if (body.model !== undefined) { sets.push('model = ?'); params.push(body.model); }
  if (body.api_key !== undefined) { sets.push('api_key = ?'); params.push(body.api_key.trim()); }
  if (body.weight !== undefined) { sets.push('weight = ?'); params.push(body.weight); }
  if (body.temperature !== undefined) { sets.push('temperature = ?'); params.push(body.temperature); }
  if (body.max_tokens !== undefined) { sets.push('max_tokens = ?'); params.push(body.max_tokens); }
  if (body.enabled !== undefined) { sets.push('enabled = ?'); params.push(body.enabled); }
  params.push(id);

  await env.DB.prepare(`UPDATE ai_channels SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();

  return json({ msg: '更新成功' });
}

async function deleteChannel(env: Env, id: string): Promise<Response> {
  const result = await env.DB.prepare('DELETE FROM ai_channels WHERE id = ?').bind(id).run();
  if (!result.meta.changes) return error('模型不存在', 404);
  return json({ msg: '删除成功' });
}

// ============ 熔断恢复 ============

/** 立即解除熔断冷却（清零失败计数 + 清除冷却截止） */
async function recoverChannel(env: Env, id: string): Promise<Response> {
  const result = await env.DB.prepare(
    'UPDATE ai_channels SET fail_count = 0, disabled_until = NULL WHERE id = ?'
  ).bind(id).run();
  if (!result.meta.changes) return error('模型不存在', 404);
  return json({ msg: '已恢复' });
}

// ============ 模型连通性测试 ============

/** 掩码密钥：保留前 6 位与后 4 位 */
function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '****';
  return key.slice(0, 6) + '...' + key.slice(-4);
}

/**
 * 测试模型连通性：对条目发一次轻量的真实补全请求（"hi"，1024 token 上限）。
 * 推理模型即使回复为空（思考占满 token 预算）也视为连通正常。
 * 测试通过自动清除失败计数与熔断冷却（带验证的自愈）；
 * 测试失败不累加 fail_count（人工测试不应触发熔断）。
 */
async function testChannelConnection(env: Env, id: string): Promise<Response> {
  const channel = await env.DB.prepare('SELECT * FROM ai_channels WHERE id = ?').bind(id).first<AIChannelRow>();
  if (!channel) return error('模型不存在', 404);
  if (!channel.api_key) return json({ code: 1, ok: false, msg: '条目未配置 API Key', keys: [] });

  const start = Date.now();
  let ok = false;
  let model: string | null = null;
  let errMsg: string | null = null;
  let httpStatus: number | null = null;
  try {
    const r = await callOpenAI({
      messages: [{ role: 'user', content: 'hi' }],
      baseUrl: channel.base_url as string,
      apiKey: channel.api_key as string,
      model: channel.model as string,
      temperature: 0,
      maxTokens: 1024,
      timeout: 15,
      allowEmptyContent: true,
    });
    ok = true;
    model = r.model;
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && 'httpStatus' in err) {
      httpStatus = (err as { httpStatus: number | null }).httpStatus;
    }
  }
  const latency_ms = Date.now() - start;

  // 测试通过的自愈：清除失败计数与熔断冷却（带验证的重置）
  if (ok) {
    await env.DB.prepare(
      'UPDATE ai_channels SET fail_count = 0, disabled_until = NULL WHERE id = ?'
    ).bind(id).run();
  }

  return json({
    code: 1,
    ok,
    msg: ok ? '连接正常' : '连接失败',
    key: { masked: maskKey(channel.api_key as string), ok, latency_ms, model, error: errMsg, http_status: httpStatus },
  });
}
