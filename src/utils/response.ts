/** JSON 响应（CORS 由 index.ts 顶层 applyCors 统一注入；禁止缓存避免浏览器缓存陈旧数据） */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** 成功响应 */
export function ok(data: Record<string, unknown> = {}, msg = '成功'): Response {
  return json({ code: 1, msg, ...data });
}

/** 未找到响应 */
export function notFound(msg = '未找到'): Response {
  return json({ code: 0, msg }, 200);
}

/** 错误响应 */
export function error(msg = '错误', status = 400): Response {
  return json({ code: -1, msg }, status);
}

/** 未授权响应 */
export function unauthorized(msg = '未授权'): Response {
  return json({ code: -1, msg }, 401);
}

/** OPTIONS 预检响应（CORS 由顶层 applyCors 注入） */
export function options(): Response {
  return new Response(null, { status: 204 });
}
