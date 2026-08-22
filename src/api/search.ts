import type { Env } from '../types/env';
import { json, notFound, error, options } from '../utils/response';
import { requireApiKey } from '../auth/middleware';
import { performSearch, parseSearchInput } from './search-core';
import { getSearchRateLimitPerMin, checkRateLimit } from '../utils/rate-limit';

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

  // 搜题限流（按密钥每分钟，settings 可配，0=不限），防止密钥泄漏后被刷爆 AI 额度
  const limitPerMin = await getSearchRateLimitPerMin(env.DB);
  if (limitPerMin > 0) {
    const allowed = await checkRateLimit(env.DB, `search:${apiKeyData.id}`, limitPerMin, 60);
    if (!allowed) return error('请求过于频繁，请稍后再试', 429);
  }

  // 解析请求体
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('请求体格式错误');
  }

  const parsed = parseSearchInput(body);
  if (!parsed.ok) return error(parsed.msg);

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
