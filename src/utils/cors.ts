/** 获取 CORS 配置，从 D1 settings 表读取（带默认值缓存） */
let cachedOrigins = '*';
let cachedAt = 0;
const CACHE_TTL = 60_000; // 1 分钟缓存

export async function refreshCorsConfig(db: D1Database): Promise<void> {
  if (Date.now() - cachedAt < CACHE_TTL) return;
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('cors_origins').first<{ value: string }>();
    if (row?.value) cachedOrigins = row.value;
  } catch { /* ignore */ }
  cachedAt = Date.now();
}

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

/** 动态 CORS 响应头 */
export function dynamicCorsHeaders(origin?: string): Record<string, string> {
  const allowed = cachedOrigins;
  if (allowed === '*' || (origin && (allowed === '*' || allowed.split(',').map(s => s.trim()).includes(origin)))) {
    return {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
  }
  return {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
