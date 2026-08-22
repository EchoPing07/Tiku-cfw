import type { Env } from '../types/env';
import { json, error, options } from '../utils/response';
import { requireAuth } from '../auth/middleware';
import { parseJsonBody } from '../utils/request';
import { performSearch, parseSearchInput } from '../api/search-core';

/** 在线搜题（管理面板用）：走完整生产链路并返回详细过程信息 */
export async function debugSearchHandler(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return options();

  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  if (request.method !== 'POST') {
    return error('仅支持 POST 请求', 405);
  }

  const parsedBody = await parseJsonBody<unknown>(request);
  if (!parsedBody.ok) return parsedBody.response;

  const parsed = parseSearchInput(parsedBody.data);
  if (!parsed.ok) return error(parsed.msg);

  // apiKeyId 为 null：不更新题库密钥统计，其余（缓存/日志/模型调度）与生产一致
  const result = await performSearch(env, parsed.input, null);

  return json({ code: 1, result });
}
