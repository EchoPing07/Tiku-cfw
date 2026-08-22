import { describe, it, expect } from 'vitest';
import { parseSearchInput, truncate } from './search-core';

describe('parseSearchInput', () => {
  it('最小合法请求通过', () => {
    const r = parseSearchInput({ title: ' 1+1=? ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.title).toBe(' 1+1=? ');
      expect(r.input.images).toBeUndefined();
    }
  });

  it('title 缺失/非字符串/空白被拒绝', () => {
    expect(parseSearchInput({}).ok).toBe(false);
    expect(parseSearchInput({ title: 123 }).ok).toBe(false);
    expect(parseSearchInput({ title: '   ' }).ok).toBe(false);
    expect(parseSearchInput(null).ok).toBe(false);
  });

  it('title/options 超长被拒绝', () => {
    expect(parseSearchInput({ title: 'x'.repeat(8193) }).ok).toBe(false);
    expect(parseSearchInput({ title: 't', options: 'o'.repeat(16385) }).ok).toBe(false);
  });

  it('type/options 非字符串被拒绝', () => {
    expect(parseSearchInput({ title: 't', type: 1 }).ok).toBe(false);
    expect(parseSearchInput({ title: 't', options: ['A'] }).ok).toBe(false);
  });

  it('images 非数组（含字符串）被拒绝，不再按字符迭代', () => {
    expect(parseSearchInput({ title: 't', images: 'https://x/y.png' }).ok).toBe(false);
    expect(parseSearchInput({ title: 't', images: [1] }).ok).toBe(false);
    expect(parseSearchInput({ title: 't', images: {} }).ok).toBe(false);
  });

  it('images 过滤空串与 null，全部为空则视为无图', () => {
    const r = parseSearchInput({ title: 't', images: [' https://a.png ', '', null, undefined] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.images).toEqual(['https://a.png']);

    const r2 = parseSearchInput({ title: 't', images: ['', null] });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.input.images).toBeUndefined();
  });

  it('图片数量与 URL 长度受限', () => {
    const ten = Array.from({ length: 10 }, () => 'https://a.png');
    expect(parseSearchInput({ title: 't', images: ten }).ok).toBe(true);
    expect(parseSearchInput({ title: 't', images: [...ten, 'https://b.png'] }).ok).toBe(false);
    expect(parseSearchInput({ title: 't', images: ['https://' + 'x'.repeat(8200)] }).ok).toBe(false);
  });
});

describe('truncate', () => {
  it('null/undefined/空串返回 null', () => {
    expect(truncate(null, 10)).toBeNull();
    expect(truncate(undefined, 10)).toBeNull();
    expect(truncate('', 10)).toBeNull();
  });

  it('短字符串原样返回', () => {
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('超长截断并追加标记', () => {
    const out = truncate('a'.repeat(20), 10);
    expect(out).toBe('a'.repeat(10) + '\n...[truncated]');
    expect(out!.length).toBeLessThanOrEqual(10 + '\n...[truncated]'.length);
  });
});
