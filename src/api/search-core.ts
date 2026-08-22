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
 * 写搜索日志，按迁移状态逐级降级：
 * 全字段（0003+0005）→ 无 token 列（仅 0003）→ 基础列（仅 0001）
 */
async function insertSearchLog(env: Env, r: LogRow): Promise<void> {
  const id = uuid();
  const base = [
    r.question, r.hash, r.found ? 1 : 0, r.fromCache ? 1 : 0,
    r.answer ?? null, r.channel ?? null, r.model ?? null,
    r.durationMs, r.apiKeyId ?? null, r.error ?? null,
  ];
  try {
    await env.DB.prepare(
      `INSERT INTO search_logs (id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, api_key_id, error, ai_request, ai_response, prompt_tokens, completion_tokens, total_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, ...base, truncate(r.rawRequest, 4096), truncate(r.rawResponse, 4096),
      r.usage?.promptTokens ?? 0, r.usage?.completionTokens ?? 0, r.usage?.totalTokens ?? 0
    ).run();
  } catch {
    try {
      await env.DB.prepare(
        `INSERT INTO search_logs (id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, api_key_id, error, ai_request, ai_response)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, ...base, truncate(r.rawRequest, 4096), truncate(r.rawResponse, 4096)).run();
    } catch {
      await env.DB.prepare(
        `INSERT INTO search_logs (id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, api_key_id, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, ...base).run();
    }
  }
}

/**
 * 搜题核心流程：归一化 → 查缓存 → 未命中调 AI → 写缓存/日志。
 * apiKeyId 为 null 时（调试控制台）不更新 API 密钥使用统计。
 */
export async function performSearch(env: Env, input: SearchInput, apiKeyId: string | null): Promise<SearchCoreResult> {
  const title = input.title.trim();
  const images = input.images || [];
  const hasImages = images.length > 0;
  const startTime = Date.now();

  const { normalized, hash } = await normalizeAndHash(title);

  // 查缓存（精确匹配）
  const cached = await env.DB.prepare(
    'SELECT id, question, answer FROM questions WHERE question_hash = ?'
  ).bind(hash).first<{ id: string; question: string; answer: string }>();

  if (cached) {
    const durationMs = Date.now() - startTime;

    // hit_count++
    await env.DB.prepare(
      "UPDATE questions SET hit_count = hit_count + 1, updated_at = datetime('now') WHERE id = ?"
    ).bind(cached.id).run();

    if (apiKeyId) {
      await env.DB.prepare(
        "UPDATE api_keys SET use_count = use_count + 1, last_used = datetime('now') WHERE id = ?"
      ).bind(apiKeyId).run();
    }

    await insertSearchLog(env, {
      question: title, hash, found: true, fromCache: true,
      answer: cached.answer, durationMs, apiKeyId,
    });

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

    // 写入缓存
    await env.DB.prepare(
      `INSERT INTO questions (id, question, question_norm, question_hash, answer, type, options, source, ai_model, has_images, hit_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, 0)
       ON CONFLICT(question_hash) DO NOTHING`
    ).bind(
      uuid(), title, normalized, hash, aiResult.content,
      input.type || null, input.options || null,
      aiResult.model, hasImages ? 1 : 0
    ).run();

    if (apiKeyId) {
      await env.DB.prepare(
        "UPDATE api_keys SET use_count = use_count + 1, last_used = datetime('now') WHERE id = ?"
      ).bind(apiKeyId).run();
    }

    await insertSearchLog(env, {
      question: title, hash, found: true, fromCache: false,
      answer: aiResult.content, channel: aiResult.channelName, model: aiResult.model,
      durationMs, apiKeyId, rawRequest: aiResult.rawRequest, rawResponse: aiResult.rawResponse,
      usage: aiResult.usage,
    });

    return {
      found: true, fromCache: false, question: title, answer: aiResult.content,
      channel: aiResult.channelName, model: aiResult.model,
      durationMs, usage: aiResult.usage, error: null,
      rawRequest: aiResult.rawRequest, rawResponse: aiResult.rawResponse,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    // AI 调度错误携带原始请求/响应与首个失败渠道，便于日志排查与渠道归因
    const rawRequest = err instanceof AIError ? (err.rawRequest || null) : null;
    const rawResponse = err instanceof AIError ? (err.rawResponse || null) : null;
    const failChannel = err instanceof AIError ? (err.channel || null) : null;

    if (apiKeyId) {
      await env.DB.prepare(
        "UPDATE api_keys SET use_count = use_count + 1, last_used = datetime('now') WHERE id = ?"
      ).bind(apiKeyId).run();
    }

    await insertSearchLog(env, {
      question: title, hash, found: false, fromCache: false,
      channel: failChannel,
      durationMs, apiKeyId, error: errMsg,
      rawRequest, rawResponse,
    });

    return {
      found: false, fromCache: false, question: title, answer: null,
      channel: failChannel, model: null,
      durationMs, usage: null, error: errMsg,
      rawRequest, rawResponse,
    };
  }
}
