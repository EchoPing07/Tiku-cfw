import { describe, it, expect } from 'vitest';
import { isExpired, validateExpiry } from './expiry';

describe('isExpired', () => {
  it('null 永不过期', () => {
    expect(isExpired(null)).toBe(false);
  });

  it('纯日期按当日结束（UTC 23:59:59）解释', () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(isExpired(tomorrow)).toBe(false);
    expect(isExpired(yesterday)).toBe(true);
  });

  it('带时间的字符串按时刻比较', () => {
    const past = new Date(Date.now() - 3_600_000).toISOString().slice(0, 19);
    const future = new Date(Date.now() + 3_600_000).toISOString().slice(0, 19);
    expect(isExpired(past)).toBe(true);
    expect(isExpired(future)).toBe(false);
  });

  it('非法格式解析失败视为未过期（写入侧由 validateExpiry 拦截）', () => {
    expect(isExpired('not-a-date')).toBe(false);
  });
});

describe('validateExpiry', () => {
  it('空值（null/undefined/空串）合法，规整为 null（永不过期）', () => {
    expect(validateExpiry(null)).toEqual({ valid: true, value: null });
    expect(validateExpiry(undefined)).toEqual({ valid: true, value: null });
    expect(validateExpiry('')).toEqual({ valid: true, value: null });
  });

  it('合法日期通过', () => {
    expect(validateExpiry('2030-01-02')).toEqual({ valid: true, value: '2030-01-02' });
    expect(validateExpiry(' 2030-01-02 ')).toEqual({ valid: true, value: '2030-01-02' });
    expect(validateExpiry('2030-01-02 08:00:00')).toEqual({ valid: true, value: '2030-01-02T08:00:00' });
    expect(validateExpiry('2030-01-02T08:00:00')).toEqual({ valid: true, value: '2030-01-02T08:00:00' });
  });

  it('拒绝非法格式', () => {
    expect(validateExpiry('2030/01/02').valid).toBe(false);
    expect(validateExpiry('abc').valid).toBe(false);
    expect(validateExpiry(20260101).valid).toBe(false);
    expect(validateExpiry('2030-1-2').valid).toBe(false);
  });

  it('拒绝被 Date 自动进位的非法日期（如 2 月 30 日）', () => {
    expect(validateExpiry('2026-02-30').valid).toBe(false);
    expect(validateExpiry('2026-13-01').valid).toBe(false);
    expect(validateExpiry('2024-02-29').valid).toBe(true); // 闰年合法
    expect(validateExpiry('2026-02-29').valid).toBe(false); // 平年非法
  });
});
