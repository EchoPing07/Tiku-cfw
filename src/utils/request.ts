import { error } from './response';

/** 安全解析 JSON 请求体，失败返回 400 响应（避免裸 request.json() 抛错被顶层当 500） */
export async function parseJsonBody<T>(request: Request): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  try {
    const data = await request.json() as T;
    return { ok: true, data };
  } catch {
    return { ok: false, response: error('请求体格式错误') };
  }
}
