import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TZ_OFFSET_MIN,
  parseTimezoneOffset,
  tzLabel,
  tzModifier,
  toSqlUTC,
  localDayStartUTC,
} from './timezone';

describe('parseTimezoneOffset', () => {
  it('接受合法偏移（含负数与非整小时）', () => {
    expect(parseTimezoneOffset(480)).toBe(480);
    expect(parseTimezoneOffset('-330')).toBe(-330);
    expect(parseTimezoneOffset('0')).toBe(0);
  });

  it('拒绝越界与非数字', () => {
    expect(parseTimezoneOffset(841)).toBeNull();
    expect(parseTimezoneOffset(-721)).toBeNull();
    expect(parseTimezoneOffset('abc')).toBeNull();
    expect(parseTimezoneOffset(null)).toBeNull();
  });
});

describe('tzLabel / tzModifier', () => {
  it('偏移 → 显示标签', () => {
    expect(tzLabel(480)).toBe('UTC+8');
    expect(tzLabel(330)).toBe('UTC+5:30');
    expect(tzLabel(-300)).toBe('UTC-5');
    expect(tzLabel(0)).toBe('UTC+0');
  });

  it('偏移 → SQLite 修饰符', () => {
    expect(tzModifier(480)).toBe('+480 minutes');
    expect(tzModifier(-330)).toBe('-330 minutes');
  });
});

describe('toSqlUTC', () => {
  it('Date → YYYY-MM-DD HH:MM:SS', () => {
    expect(toSqlUTC(new Date('2026-08-23T06:30:00Z'))).toBe('2026-08-23 06:30:00');
  });
});

describe('localDayStartUTC', () => {
  it('北京时间：本地日零点折算为 UTC 前一日 16:00', () => {
    // 2026-08-23T02:00:00Z = 北京 8 月 23 日 10:00，本地日零点 = UTC 8 月 22 日 16:00
    const now = new Date('2026-08-23T02:00:00Z');
    expect(localDayStartUTC(now, DEFAULT_TZ_OFFSET_MIN)).toBe('2026-08-22 16:00:00');
  });

  it('北京时间：UTC 时间早于零点差（本地仍在前一日）', () => {
    // 2026-08-23T10:00:00Z = 北京 8 月 23 日 18:00，本地日零点 = UTC 8 月 22 日 16:00
    const now = new Date('2026-08-23T10:00:00Z');
    expect(localDayStartUTC(now, DEFAULT_TZ_OFFSET_MIN)).toBe('2026-08-22 16:00:00');
  });

  it('负偏移（UTC-5）：本地日零点 = UTC 当日 05:00', () => {
    // 2026-08-23T02:00:00Z = 纽约 8 月 22 日 21:00，本地日零点 = UTC 8 月 22 日 05:00
    const now = new Date('2026-08-23T02:00:00Z');
    expect(localDayStartUTC(now, -300)).toBe('2026-08-22 05:00:00');
  });

  it('dayShift 往前推 N 天', () => {
    const now = new Date('2026-08-23T02:00:00Z');
    expect(localDayStartUTC(now, DEFAULT_TZ_OFFSET_MIN, 13)).toBe('2026-08-09 16:00:00');
    expect(localDayStartUTC(now, DEFAULT_TZ_OFFSET_MIN, 0)).toBe('2026-08-22 16:00:00');
  });
});
