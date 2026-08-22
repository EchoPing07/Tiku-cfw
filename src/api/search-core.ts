import type { Env } from '../types/env';
import { normalizeAndHash } from '../cache/normalize';
import { dispatchAI } from '../ai/dispatcher';
import { AIError, type TokenUsage } from '../ai/types';
import { uuid } from '../utils/id';

/** 搜题输入 */
export interface SearchInput {
  title: string;
  type?: string;
  options?: string;
  images?: string[];
}

/** 搜题结果（供 OCS 接口与调试控制台共用） */
export interface SearchCoreResult {
  found: boolean;
  fromCache: boolean;
  /** 命中的题目文本（缓存命中为缓存题目，AI 生成为原始题目） */
  question: string;
  answer: string | null;
  channel: string | null;
  model: string | null;
  durationMs: number;
  usage: TokenUsage | null;
  error: string | null;
  rawRequest: string | null;
  rawResponse: string | null;
  /** 输入本身无效（如归一化后为空），调用方应对外返回 400 而非"未找到" */
  invalidInput?: boolean;
}

/** 输入上限：防畸形/超大请求撑爆 AI 提示词与日志行 */
const MAX_TITLE_LEN = 8192;
const MAX_OPTIONS_LEN = 16384;
const MAX_IMAGES = 10;
const MAX_IMAGE_URL_LEN = 8192;

/**
 * 校验搜题请求体（类型 + 长度），兼容 OCS 客户端与调试台。
 * images 过滤空项与 null，全部过滤后视为无图（走文本模型）。
 */
export function parseSearchInput(body: unknown): { ok: true; input: SearchInput } | { ok: false; msg: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, msg: '请求体格式错误' };
  const b = body as Record<string, unknown>;

  if (typeof b.title !== 'string' || !b.title.trim()) return { ok: false, msg: '题目(title)不能为空' };
  if (b.title.length > MAX_TITLE_LEN) return { ok: false, msg: `题目过长（≤${MAX_TITLE_LEN} 字符）` };

  if (b.type !== undefined && b.type !== null && typeof b.type !== 'string') {
    return { ok: false, msg: '题型(type)必须为字符串' };
  }
  if (b.options !== undefined && b.options !== null) {
    if (typeof b.options !== 'string') return { ok: false, msg: '选项(options)必须为字符串' };
    if (b.options.length > MAX_OPTIONS_LEN) return { ok: false, msg: `选项内容过长（≤${MAX_OPTIONS_LEN} 字符）` };
  }

  let images: string[] | undefined;
  if (b.images !== undefined && b.images !== null) {
    if (!Array.isArray(b.images)) return { ok: false, msg: '图片(images)必须是字符串数组' };
    const imgs: string[] = [];
    for (const it of b.images) {
      if (it === null || it === undefined) continue;
      if (typeof it !== 'string') return { ok: false, msg: '图片列表包含非字符串项' };
      const u = it.trim();
      if (!u) continue;
      if (u.length > MAX_IMAGE_URL_LEN) return { ok: false, msg: '图片 URL 过长' };
      imgs.push(u);
    }
    if (imgs.length > MAX_IMAGES) return { ok: false, msg: `图片数量过多（≤${MAX_IMAGES} 张）` };
    images = imgs.length > 0 ? imgs : undefined;
  }

  return {
    ok: true,
    input: {
      title: b.title,
      type: typeof b.type === 'string' && b.type ? b.type : undefined,
      options: typeof b.options === 'string' && b.options ? b.options : undefined,
      images,
    },
  };
}

/** 截断字符串到指定长度，超长则追加截断标记 */
export function truncate(s: string | null | undefined, maxLen: number): string | null {
  if (!s) return null;
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '\n...[truncated]';
}

interface LogRow {
  question: string;
  hash: string;
  found: boolean;
  fromCache: boolean;
  answer?: string | null;
  channel?: string | null;
  model?: string | null;
  durationMs: number;
  apiKeyId?: string | null;
  error?: string | null;
  rawRequest?: string | null;
  rawResponse?: string | null;
  usage?: TokenUsage | null;
}

/**
 * 写搜索日志：按迁移状态逐级降级构造语句（全字段 0003+0005 → 无 token 列 0003 → 基础列 0001）。
 * 列级别按 isolate 探测一次并缓存，避免每次写入都先经历失败查询。
 */
type LogsSchema = 'full' | 'debug' | 'base';
let logsSchema: LogsSchema | null = null;

const isNoSuchColumn = (err: unknown): boolean => err instanceof Error && /no such column/i.test(err.message);

async function detectLogsSchema(env: Env): Promise<LogsSchema> {
  if (logsSchema) return logsSchema;
  try {
    await env.DB.prepare(
      'SELECT ai_request, ai_response, prompt_tokens, completion_tokens, total_tokens FROM search_logs LIMIT 1'
    ).first();
    logsSchema = 'full';
  } catch (err) {
    if (!isNoSuchColumn(err)) throw err;
    try {
      await env.DB.prepare('SELECT ai_request, ai_response FROM search_logs LIMIT 1').first();
      logsSchema = 'debug';
    } catch (err2) {
      if (!isNoSuchColumn(err2)) throw err2;
      logsSchema = 'base';
    }
  }
  return logsSchema;
}

/** 构造日志 INSERT 语句（并入 batch 一次往返写入）；schema 探测失败时返回 null（放弃本条日志） */
async function buildLogStmt(env: Env, r: LogRow): Promise<D1PreparedStatement | null> {
  let schema: LogsSchema;
  try {
    schema = await detectLogsSchema(env);
  } catch {
    return null;
  }
  const id = uuid();
  const base = [
    r.question, r.hash, r.found ? 1 : 0, r.fromCache ? 1 : 0,
    r.answer ?? null, r.channel ?? null, r.model ?? null,
    r.durationMs, r.apiKeyId ?? null, r.error ?? null,
  ];
  if (schema === 'full') {
    return env.DB.prepare(
      `INSERT INTO search_logs (id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, api_key_id, error, ai_request, ai_response, prompt_tokens, completion_tokens, total_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, ...base, truncate(r.rawRequest, 4096), truncate(r.rawResponse, 4096),
      r.usage?.promptTokens ?? 0, r.usage?.completionTokens ?? 0, r.usage?.totalTokens ?? 0
    );
  }
  if (schema === 'debug') {
    return env.DB.prepare(
      `INSERT INTO search_logs (id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, api_key_id, error, ai_request, ai_response)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, ...base, truncate(r.rawRequest, 4096), truncate(r.rawResponse, 4096));
  }
  return env.DB.prepare(
    `INSERT INTO search_logs (id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, api_key_id, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, ...base);
}

/** 合并执行写库语句（单次 D1 往返）；失败仅记 console，不影响搜题结果返回 */
async function safeBatch(env: Env, stmts: Array<D1PreparedStatement | null>): Promise<void> {
  const list = stmts.filter((s): s is D1PreparedStatement => s !== null);
  if (list.length === 0) return;
  try {
    await env.DB.batch(list);
  } catch (err) {
    console.error('post-search DB writes failed:', err);
  }
}

/**
 * 搜题核心流程：归一化 → 查缓存 → 未命中调 AI → 写缓存/日志。
 * apiKeyId 为 null 时（管理面板在线搜题）不更新题库密钥使用统计。
 */
export async function performSearch(env: Env, input: SearchInput, apiKeyId: string | null): Promise<SearchCoreResult> {
  const title = input.title.trim();
  const images = input.images || [];
  const hasImages = images.length > 0;
  const startTime = Date.now();

  const { normalized, hash } = await normalizeAndHash(title);

  // 归一化后为空（题目只含标点/格式标记等）：不查缓存也不调 AI，
  // 避免所有"空"题目命中同一条 SHA-256("") 缓存互相串答案
  if (!normalized) {
    const durationMs = Date.now() - startTime;
    const msg = '题目内容无效（去除格式标记后为空）';
    await safeBatch(env, [
      await buildLogStmt(env, { question: title, hash, found: false, fromCache: false, durationMs, apiKeyId, error: msg }),
    ]);
    return {
      found: false, fromCache: false, question: title, answer: null,
      channel: null, model: null, durationMs, usage: null, error: msg,
      rawRequest: null, rawResponse: null, invalidInput: true,
    };
  }

  // 查缓存（精确匹配）
  const cached = await env.DB.prepare(
    'SELECT id, question, answer FROM questions WHERE question_hash = ?'
  ).bind(hash).first<{ id: string; question: string; answer: string }>();

  if (cached) {
    const durationMs = Date.now() - startTime;

    // 命中计数 / 密钥用量 / 日志合并为一次 batch，且失败不影响返回答案
    await safeBatch(env, [
      env.DB.prepare(
        "UPDATE questions SET hit_count = hit_count + 1, updated_at = datetime('now') WHERE id = ?"
      ).bind(cached.id),
      apiKeyId
        ? env.DB.prepare(
            "UPDATE api_keys SET use_count = use_count + 1, last_used = datetime('now') WHERE id = ?"
          ).bind(apiKeyId)
        : null,
      await buildLogStmt(env, {
        question: title, hash, found: true, fromCache: true,
        answer: cached.answer, durationMs, apiKeyId,
      }),
    ]);

    return {
      found: true, fromCache: true, question: cached.question, answer: cached.answer,
      channel: null, model: null, durationMs, usage: null, error: null,
      rawRequest: null, rawResponse: null,
    };
  }

  // 未命中缓存，调用 AI
  try {
    const aiResult = await dispatchAI({
      title,
      type: input.type as any,
      options: input.options,
      images,
      env,
    });

    const durationMs = Date.now() - startTime;

    // 缓存写入 / 密钥用量 / 日志合并为一次 batch；写失败仅记日志，答案照常返回
    await safeBatch(env, [
      env.DB.prepare(
        `INSERT INTO questions (id, question, question_norm, question_hash, answer, type, options, source, ai_model, has_images, hit_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, 0)
         ON CONFLICT(question_hash) DO NOTHING`
      ).bind(
        uuid(), title, normalized, hash, aiResult.content,
        input.type || null, input.options || null,
        aiResult.model, hasImages ? 1 : 0
      ),
      apiKeyId
        ? env.DB.prepare(
            "UPDATE api_keys SET use_count = use_count + 1, last_used = datetime('now') WHERE id = ?"
          ).bind(apiKeyId)
        : null,
      await buildLogStmt(env, {
        question: title, hash, found: true, fromCache: false,
        answer: aiResult.content, channel: aiResult.channelName, model: aiResult.model,
        durationMs, apiKeyId, rawRequest: aiResult.rawRequest, rawResponse: aiResult.rawResponse,
        usage: aiResult.usage,
      }),
    ]);

    return {
      found: true, fromCache: false, question: title, answer: aiResult.content,
      channel: aiResult.channelName, model: aiResult.model,
      durationMs, usage: aiResult.usage, error: null,
      rawRequest: aiResult.rawRequest, rawResponse: aiResult.rawResponse,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    // AI 调度错误携带原始请求/响应与首个失败模型，便于日志排查与模型归因
    const rawRequest = err instanceof AIError ? (err.rawRequest || null) : null;
    const rawResponse = err instanceof AIError ? (err.rawResponse || null) : null;
    const failChannel = err instanceof AIError ? (err.channel || null) : null;

    await safeBatch(env, [
      apiKeyId
        ? env.DB.prepare(
            "UPDATE api_keys SET use_count = use_count + 1, last_used = datetime('now') WHERE id = ?"
          ).bind(apiKeyId)
        : null,
      await buildLogStmt(env, {
        question: title, hash, found: false, fromCache: false,
        channel: failChannel,
        durationMs, apiKeyId, error: errMsg,
        rawRequest, rawResponse,
      }),
    ]);

    return {
      found: false, fromCache: false, question: title, answer: null,
      channel: failChannel, model: null,
      durationMs, usage: null, error: errMsg,
      rawRequest, rawResponse,
    };
  }
}
