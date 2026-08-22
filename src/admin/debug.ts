import type { Env } from '../types/env';
import { json, error, options } from '../utils/response';
import { requireAuth } from '../auth/middleware';
import { parseJsonBody } from '../utils/request';
import { performSearch } from '../api/search-core';

/** 在线搜题（管理面板用）：走完整生产链路并返回详细过程信息 */
export async function debugSearchHandler(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return options();

  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  if (request.method !== 'POST') {
    return error('仅支持 POST 请求', 405);
  }

  const parsed = await parseJsonBody<{ title?: string; type?: string; options?: string; images?: string[] }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.title || !body.title.trim()) {
    return error('题目(title)不能为空');
  }

  // apiKeyId 为 null：不更新题库密钥统计，其余（缓存/日志/模型调度）与生产一致
  const result = await performSearch(env, {
    title: body.title,
    type: body.type,
    options: body.options,
    images: body.images,
  }, null);

  return json({ code: 1, result });
}
