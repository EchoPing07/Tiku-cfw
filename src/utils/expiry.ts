/**
 * 判断过期时间是否已过。
 * expires_at 存为 'YYYY-MM-DD'（前端 date input），按当天结束 UTC 解释，
 * 兼容已带时间后缀的 'YYYY-MM-DDTHH:MM:SS' 格式；null 表示永不过期。
 */
export function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  let normalized: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
    normalized = expiresAt + 'T23:59:59Z';
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}$/.test(expiresAt)) {
    // 无时区后缀的时刻按 UTC 解释（与 D1 datetime('now') 口径一致），避免 Date 按本地时区解析
    normalized = expiresAt.replace(' ', 'T') + 'Z';
  } else {
    normalized = expiresAt;
  }
  const expiry = new Date(normalized).getTime();
  return Number.isFinite(expiry) && Date.now() > expiry;
}

/**
 * 校验并规整过期时间输入：null/undefined/空串 → null（永不过期）；
 * 接受 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:MM:SS'（统一规整为 ISO 'T' 分隔）。
 * valid=false 表示格式或日期非法（调用方应返回 400），避免脏值静默变成"永不过期"。
 */
export function validateExpiry(v: unknown): { valid: true; value: string | null } | { valid: false } {
  if (v === null || v === undefined || v === '') return { valid: true, value: null };
  if (typeof v !== 'string') return { valid: false };
  const s = v.trim().replace(' ', 'T');
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/.exec(s);
  if (!m) return { valid: false };
  const d = new Date(m[4] ? s + 'Z' : `${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return { valid: false };
  // 拒绝 2026-02-31 这类被 Date 自动进位的非法日期
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return { valid: false };
  }
  return { valid: true, value: s };
}
