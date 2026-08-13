/**
 * 判断过期时间是否已过。
 * expires_at 存为 'YYYY-MM-DD'（前端 date input），按当天结束 UTC 解释，
 * 兼容已带时间后缀的 'YYYY-MM-DDTHH:MM:SS' 格式；null 表示永不过期。
 */
export function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)
    ? expiresAt + 'T23:59:59Z'
    : expiresAt;
  const expiry = new Date(normalized).getTime();
  return Number.isFinite(expiry) && Date.now() > expiry;
}
