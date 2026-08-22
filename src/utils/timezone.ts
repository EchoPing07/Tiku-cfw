import type { Env } from '../types/env';

/** 默认统计时区：北京时间 UTC+8 */
export const DEFAULT_TZ_OFFSET_MIN = 480;

/** 读取统计时区偏移（分钟），缺失或非法时回退北京时间 */
export async function getTimezoneOffsetMinutes(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'timezone_offset'"
    ).first<{ value: string }>();
    const v = parseInt(row?.value || '', 10);
    if (Number.isFinite(v) && v >= -720 && v <= 840) return v;
  } catch { /* 回退默认 */ }
  return DEFAULT_TZ_OFFSET_MIN;
}

/** 校验时区偏移（分钟），合法返回数字，否则 null */
export function parseTimezoneOffset(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= -720 && n <= 840 ? n : null;
}

/** 偏移 → 显示标签，如 UTC+8 / UTC+5:30 / UTC-5 */
export function tzLabel(offsetMin: number): string {
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return 'UTC' + sign + h + (m ? ':' + String(m).padStart(2, '0') : '');
}

/** 偏移 → SQLite 日期修饰符，如 '+480 minutes' / '-330 minutes' */
export function tzModifier(offsetMin: number): string {
  return (offsetMin < 0 ? '-' : '+') + Math.abs(offsetMin) + ' minutes';
}

/** Date → SQLite 可比较的 UTC 时刻 'YYYY-MM-DD HH:MM:SS' */
export function toSqlUTC(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 本地日（往前 dayShift 天）零点对应的 UTC 时刻。
 * 例：北京时间 8 月 22 日的零点 = UTC 8 月 21 日 16:00。
 * 作为绑定参数参与 `created_at >= ?` 比较可正常走 created_at 索引。
 */
export function localDayStartUTC(now: Date, offsetMin: number, dayShift = 0): string {
  const shifted = new Date(now.getTime() + offsetMin * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  if (dayShift > 0) shifted.setUTCDate(shifted.getUTCDate() - dayShift);
  return toSqlUTC(new Date(shifted.getTime() - offsetMin * 60_000));
}
