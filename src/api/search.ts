import type { Env } from '../types/env';
import { json, notFound, error, options } from '../utils/response';
import { requireApiKey } from '../auth/middleware';
import { performSearch, parseSearchInput, logBadInput } from './search-core';
import { getSearchRateLimitPerMin, checkRateLimit } from '../utils/rate-limit';
import { normalizeAndHash } from '../cache/normalize';

/** 入站请求的哈希（日志行需要 question_hash 非空；bad_input 用原始文本哈希） */
async function hashRaw(raw: string): Promise<string> {
  const { hash } = await normalizeAndHash(raw);
  return hash;
}

/**
 * 连通性探测响应（GET / HEAD /api/search）。
 *
 * OCS 5.1.0 起题库状态探测改为向 `item.url` 本身（即本接口路径）发 HEAD（405/501 时回退
 * GET）并要求 2xx–3xx 才算「连接成功」（scripts/src/utils/ui.ts probeAnswerer）。若这里仍按
 * 「仅支持 POST」回 405，OCS 面板会稳定显示「连接失败（405）」而 POST 搜题其实完全正常。
 *
 * 该响应不含任何密钥/题库数据，可安全匿名访问：HEAD 返回空 200，GET 返回接口说明。
 */
export function probeResponse(method: string): Response {
  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }
  return json({
    code: 1,
    msg: 'Tiku-cfw 搜题接口正常，请使用 POST 提交 JSON 请求体',
    service: 'tiku-cfw',
    status: 'ok',
  });
}

/** 搜题接口（OCS 兼容） */
export async function searchHandler(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return options();

  // 非 POST：视为连通性探测（OCS 5.x 用 HEAD/GET 探活），返回 200 而非 405
  if (request.method !== 'POST') {
    return probeResponse(request.method);
  }

  // API Key 鉴权
  const authResult = await requireApiKey(request, env);
  if (!authResult.ok) return authResult.response;
  const apiKeyData = authResult.data;

  // 搜题限流（按密钥每分钟，settings 可配，0=不限），防止密钥泄漏后被刷爆 AI 额度
  const limitPerMin = await getSearchRateLimitPerMin(env.DB);
  if (limitPerMin > 0) {
    const allowed = await checkRateLimit(env.DB, `search:${apiKeyData.id}`, limitPerMin, 60);
    if (!allowed) return error('请求过于频繁，请稍后再试', 429);
  }

  // 解析请求体（格式错误/校验失败也写日志，消灭入站请求盲区）
  let body: unknown;
  let rawBody = '';
  try {
    rawBody = await request.text();
    body = JSON.parse(rawBody);
  } catch {
    await logBadInput(env, rawBody, await hashRaw(rawBody), '请求体不是合法 JSON');
    return error('请求体格式错误');
  }

  const parsed = parseSearchInput(body);
  if (!parsed.ok) {
    await logBadInput(env, rawBody, await hashRaw(rawBody), parsed.msg);
    return error(parsed.msg);
  }

  const result = await performSearch(env, parsed.input, apiKeyData.id);

  if (result.invalidInput) return error(result.error || '题目内容无效');
  if (result.found) {
    return json({
      code: 1,
      question: result.question,
      answer: result.answer,
      msg: '成功',
    });
  }
  return notFound('未找到题目');
}
