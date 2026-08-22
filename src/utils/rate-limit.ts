/**
 * 基于 D1 固定窗口计数的简易限流：管理登录防爆破（按 IP）、搜题配额（按密钥）。
 * 依赖 0006 迁移的 rate_limits 表；表缺失或 D1 故障时放行（fail-open，限流不应阻断业务）。
 */

/** 管理登录：每个 IP 窗口期与最大尝试次数 */
export const LOGIN_WINDOW_SEC = 300;
export const LOGIN_MAX_ATTEMPTS = 10;

/** 搜题限流默认值（每分钟每密钥），settings 可覆盖 */
export const DEFAULT_SEARCH_RATE_LIMIT = 120;

let cachedSearchLimit: number | null = null;
let cachedSearchLimitAt = 0;
const SETTINGS_CACHE_TTL = 60_000;

/** 读取搜题限流配置（每分钟每密钥次数，0=不限），带 1 分钟内存缓存 */
export async function getSearchRateLimitPerMin(db: D1Database): Promise<number> {
  if (cachedSearchLimit !== null && Date.now() - cachedSearchLimitAt < SETTINGS_CACHE_TTL) {
    return cachedSearchLimit;
  }
  let v = DEFAULT_SEARCH_RATE_LIMIT;
  try {
    const row = await db.prepare(
      "SELECT value FROM settings WHERE key = 'search_rate_limit'"
    ).first<{ value: string }>();
    if (row?.value !== undefined) {
      const n = parseInt(row.value, 10);
      if (Number.isFinite(n) && n >= 0) v = n;
    }
  } catch { /* 默认值 */ }
  cachedSearchLimit = v;
  cachedSearchLimitAt = Date.now();
  return v;
}

/**
 * 固定窗口计数限流：本次为窗口内第 N 次访问，N > limit 则拒绝。
 * window_start 存整窗起点的 unix 秒字符串，同窗累加、跨窗重置；过期行由每日定时任务清理。
 */
export async function checkRateLimit(db: D1Database, key: string, limit: number, windowSec: number): Promise<boolean> {
  if (!(limit > 0)) return true;
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = String(Math.floor(nowSec / windowSec) * windowSec);
  try {
    const row = await db.prepare(
      `INSERT INTO rate_limits (k, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(k) DO UPDATE SET
         count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`
    ).bind(key, windowStart).first<{ count: number }>();
    return (row?.count ?? 0) <= limit;
  } catch {
    return true; // fail-open
  }
}
