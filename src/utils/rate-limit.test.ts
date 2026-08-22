import { describe, it, expect, vi } from 'vitest';
import { checkRateLimit, DEFAULT_SEARCH_RATE_LIMIT } from './rate-limit';
import type { D1Database } from '@cloudflare/workers-types';

/** 极简 D1 mock：兼容 .prepare().first() 与 .prepare().bind().first() 两种调用链 */
function fakeDB(opts: { fail?: boolean; count?: number; settingValue?: string } = {}): D1Database {
  const doFirst = async (): Promise<unknown> => {
    if (opts.fail) throw new Error('db down');
    if (opts.count !== undefined) return { count: opts.count };
    return { value: opts.settingValue };
  };
  const stmt: Record<string, unknown> = {
    bind: () => stmt,
    first: doFirst,
  };
  return { prepare: () => stmt } as unknown as D1Database;
}

describe('checkRateLimit', () => {
  it('limit<=0 直接放行（不限流）', async () => {
    expect(await checkRateLimit(fakeDB({ fail: true }), 'k', 0, 60)).toBe(true);
  });

  it('窗口内计数未超上限放行', async () => {
    expect(await checkRateLimit(fakeDB({ count: 10 }), 'k', 10, 60)).toBe(true);
  });

  it('窗口内计数超上限拒绝', async () => {
    expect(await checkRateLimit(fakeDB({ count: 11 }), 'k', 10, 60)).toBe(false);
  });

  it('D1 故障时 fail-open 放行', async () => {
    expect(await checkRateLimit(fakeDB({ fail: true }), 'k', 10, 60)).toBe(true);
  });
});

describe('getSearchRateLimitPerMin', () => {
  // 模块内有 60s 读取缓存；用 resetModules + 动态 import 取干净实例
  async function freshModule() {
    vi.resetModules();
    return await import('./rate-limit');
  }

  it('读取 settings 中的限流值', async () => {
    const { getSearchRateLimitPerMin: f } = await freshModule();
    expect(await f(fakeDB({ settingValue: '60' }))).toBe(60);
  });

  it('60s 内命中缓存：重复调用不再读库', async () => {
    const { getSearchRateLimitPerMin: f } = await freshModule();
    expect(await f(fakeDB({ settingValue: '60' }))).toBe(60);
    // 换一个返回 30 的 DB，仍应拿到缓存中的 60（未发起读取）
    expect(await f(fakeDB({ settingValue: '30' }))).toBe(60);
  });

  it('settings 缺失/故障/非法值时回退默认值', async () => {
    expect(DEFAULT_SEARCH_RATE_LIMIT).toBe(120);
    const { getSearchRateLimitPerMin: f1 } = await freshModule();
    expect(await f1(fakeDB({ fail: true }))).toBe(120);
    const { getSearchRateLimitPerMin: f2 } = await freshModule();
    expect(await f2(fakeDB({ settingValue: 'abc' }))).toBe(120);
    const { getSearchRateLimitPerMin: f3 } = await freshModule();
    expect(await f3(fakeDB({ settingValue: '-5' }))).toBe(120);
  });
});
