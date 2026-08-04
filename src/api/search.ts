import type { Env } from '../types/env';
import { json, notFound, error, options } from '../utils/response';
import { requireApiKey } from '../auth/middleware';
import { normalizeAndHash } from '../cache/normalize';
import { dispatchAI } from '../ai/dispatcher';
import { AIError } from '../ai/types';
import { uuid } from '../utils/id';

/** 截断字符串到指定长度，超长则追加截断标记 */
function truncate(s: string | null | undefined, maxLen: number): string | null {
  if (!s) return null;
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '\n...[truncated]';
}

interface SearchBody {
  title?: string;
  type?: string;
  options?: string;
  images?: string[];
}

/** 搜题接口（OCS 兼容） */
export async function searchHandler(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return options();

  if (request.method !== 'POST') {
    return error('仅支持 POST 请求', 405);
  }

  // API Key 鉴权
  const authResult = await requireApiKey(request, env);
  if (!authResult.ok) return authResult.response;
  const apiKeyData = authResult.data;

  // 解析请求体
  let body: SearchBody;
  try {
    body = await request.json() as SearchBody;
  } catch {
    return error('请求体格式错误');
  }

  if (!body.title || !body.title.trim()) {
    return error('题目(title)不能为空');
  }

  const title = body.title.trim();
  const type = body.type;
  const questionOptions = body.options;
  const images = body.images || [];
  const hasImages = images.length > 0;

  const startTime = Date.now();

  // 题目归一化 + 哈希
  const { normalized, hash } = await normalizeAndHash(title);

  // 查缓存（精确匹配）
  const cached = await env.DB.prepare(
    'SELECT * FROM questions WHERE question_hash = ?'
  ).bind(hash).first<{
    id: string;
    question: string;
    answer: string;
    type: string | null;
  }>();

  if (cached) {
    // 命中缓存
    const duration = Date.now() - startTime;

    // hit_count++
    await env.DB.prepare(
      'UPDATE questions SET hit_count = hit_count + 1, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(cached.id).run();

    // 更新 API Key 使用统计
    await env.DB.prepare(
      'UPDATE api_keys SET use_count = use_count + 1, last_used = datetime(\'now\') WHERE id = ?'
    ).bind(apiKeyData.id).run();

    // 写日志
    await env.DB.prepare(
      `INSERT INTO search_logs (id, question, question_hash, found, from_cache, answer, duration_ms, api_key_id)
       VALUES (?, ?, ?, 1, 1, ?, ?, ?)`
    ).bind(uuid(), title, hash, cached.answer, duration, apiKeyData.id).run();

    return json({
      code: 1,
      question: cached.question,
      answer: cached.answer,
      msg: '成功',
    });
  }

  // 未命中缓存，调用 AI
  try {
    const aiResult = await dispatchAI({
      title,
      type: type as any,
      options: questionOptions,
      images,
      env,
    });

    const duration = Date.now() - startTime;

    // 写入缓存
    const questionId = uuid();
    await env.DB.prepare(
      `INSERT INTO questions (id, question, question_norm, question_hash, answer, type, options, source, ai_model, has_images, hit_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, 0)
       ON CONFLICT(question_hash) DO NOTHING`
    ).bind(
      questionId,
      title,
      normalized,
      hash,
      aiResult.content,
      type || null,
      questionOptions || null,
      aiResult.model,
      hasImages ? 1 : 0
    ).run();

    // 更新 API Key 使用统计
    await env.DB.prepare(
      'UPDATE api_keys SET use_count = use_count + 1, last_used = datetime(\'now\') WHERE id = ?'
    ).bind(apiKeyData.id).run();

    // 写日志（含 AI 请求/响应原始内容，方便排查）
    // 如果迁移 0003 未执行，ai_request/ai_response 列不存在，fallback 到无新列写入
    try {
      await env.DB.prepare(
        `INSERT INTO search_logs (id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, api_key_id, ai_request, ai_response)
         VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        uuid(), title, hash, aiResult.content, aiResult.channelName, aiResult.model, duration, apiKeyData.id,
        truncate(aiResult.rawRequest, 4096), truncate(aiResult.rawResponse, 4096)
      ).run();
    } catch {
      await env.DB.prepare(
        `INSERT INTO search_logs (id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, api_key_id)
         VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`
      ).bind(
        uuid(), title, hash, aiResult.content, aiResult.channelName, aiResult.model, duration, apiKeyData.id
      ).run();
    }

    return json({
      code: 1,
      question: title,
      answer: aiResult.content,
      msg: '成功',
    });
  } catch (err) {
    const duration = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    // 如果是 AI 调度错误，提取原始请求/响应用于日志排查
    const aiRequest = err instanceof AIError ? (err.rawRequest || null) : null;
    const aiResponse = err instanceof AIError ? (err.rawResponse || null) : null;

    // 更新 API Key 使用统计（即使失败也计数）
    await env.DB.prepare(
      'UPDATE api_keys SET use_count = use_count + 1, last_used = datetime(\'now\') WHERE id = ?'
    ).bind(apiKeyData.id).run();

    // 写日志（含 AI 请求/响应原始内容，方便排查）
    // 如果迁移 0003 未执行，ai_request/ai_response 列不存在，fallback 到无新列写入
    try {
      await env.DB.prepare(
        `INSERT INTO search_logs (id, question, question_hash, found, from_cache, duration_ms, api_key_id, error, ai_request, ai_response)
         VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`
      ).bind(uuid(), title, hash, duration, apiKeyData.id, errMsg, truncate(aiRequest, 4096), truncate(aiResponse, 4096)).run();
    } catch {
      await env.DB.prepare(
        `INSERT INTO search_logs (id, question, question_hash, found, from_cache, duration_ms, api_key_id, error)
         VALUES (?, ?, ?, 0, 0, ?, ?, ?)`
      ).bind(uuid(), title, hash, duration, apiKeyData.id, errMsg).run();
    }

    return notFound('未找到题目');
  }
}
