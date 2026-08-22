import type { Env } from '../types/env';
import { json, notFound, error, options } from '../utils/response';
import { requireApiKey } from '../auth/middleware';
import { performSearch } from './search-core';

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

  const result = await performSearch(env, {
    title: body.title,
    type: body.type,
    options: body.options,
    images: body.images,
  }, apiKeyData.id);

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
