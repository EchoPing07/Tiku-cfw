/** 允许的 CORS 源（逗号分隔），'*' 表示全部。从 D1 settings 读取，带 1 分钟内存缓存。 */
let cachedOrigins = '*';
let cachedAt = 0;
const CACHE_TTL = 60_000;

export async function refreshCorsConfig(db: D1Database): Promise<void> {
  if (Date.now() - cachedAt < CACHE_TTL) return;
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('cors_origins').first<{ value: string }>();
    if (row?.value) cachedOrigins = row.value;
  } catch { /* ignore */ }
  cachedAt = Date.now();
}

/** 当前允许的源列表 */
function allowedOrigins(): string[] {
  return cachedOrigins.split(',').map(s => s.trim()).filter(Boolean);
}

/** 判断 origin 是否被允许 */
function isOriginAllowed(origin: string | null): boolean {
  const list = allowedOrigins();
  if (list.includes('*')) return true;
  if (!origin) return false;
  return list.includes(origin);
}

/** 根据 Origin 生成 CORS 响应头 */
export function corsHeadersFor(origin: string | null): Record<string, string> {
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (isOriginAllowed(origin)) {
    return { ...base, 'Access-Control-Allow-Origin': origin || '*', 'Vary': 'Origin' };
  }
  // 未允许的源：不回 Access-Control-Allow-Origin，浏览器同源策略生效
  return base;
}

/** 给响应注入动态 CORS 头（覆盖已有值，统一由顶层调用） */
export async function applyCors(request: Request, response: Response): Promise<Response> {
  const origin = request.headers.get('Origin');
  const headers = new Headers(response.headers);
  const cors = corsHeadersFor(origin);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
