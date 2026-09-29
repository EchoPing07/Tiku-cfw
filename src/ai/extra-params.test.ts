import { describe, it, expect } from 'vitest';
import { validateExtraParams, parseExtraParams } from './extra-params';

describe('validateExtraParams（写路径）', () => {
  it('空输入统一归一化为 null（清除）', () => {
    expect(validateExtraParams(undefined)).toEqual({ ok: true, value: null });
    expect(validateExtraParams(null)).toEqual({ ok: true, value: null });
    expect(validateExtraParams('')).toEqual({ ok: true, value: null });
    expect(validateExtraParams('   ')).toEqual({ ok: true, value: null });
    expect(validateExtraParams('{}')).toEqual({ ok: true, value: null });
    expect(validateExtraParams({})).toEqual({ ok: true, value: null });
  });

  it('JSON 字符串（表单）与对象（API）等价接受', () => {
    expect(validateExtraParams('{"enable_thinking": false}')).toEqual({
      ok: true, value: '{"enable_thinking":false}',
    });
    expect(validateExtraParams({ enable_thinking: false })).toEqual({
      ok: true, value: '{"enable_thinking":false}',
    });
  });

  it('嵌套对象合法（thinking.type 形态）', () => {
    expect(validateExtraParams('{"thinking": {"type": "disabled"}}')).toEqual({
      ok: true, value: '{"thinking":{"type":"disabled"}}',
    });
  });

  it('非法 JSON 被拒绝', () => {
    const r = validateExtraParams('{"enable_thinking": false');
    expect(r.ok).toBe(false);
    expect(r.msg).toContain('JSON');
  });

  it('数组与标量被拒绝（必须是对象）', () => {
    expect(validateExtraParams('[1,2]').ok).toBe(false);
    expect(validateExtraParams('"str"').ok).toBe(false);
    expect(validateExtraParams('42').ok).toBe(false);
    expect(validateExtraParams(42).ok).toBe(false);
    expect(validateExtraParams(true).ok).toBe(false);
  });

  it('核心字段覆盖被拒绝（model/messages/temperature/max_tokens）', () => {
    for (const key of ['model', 'messages', 'temperature', 'max_tokens']) {
      const r = validateExtraParams(`{"${key}": 1}`);
      expect(r.ok).toBe(false);
      expect(r.msg).toContain(key);
    }
  });

  it('键数量与长度受限', () => {
    const tooMany: Record<string, number> = {};
    for (let i = 0; i < 21; i++) tooMany[`k${i}`] = i;
    expect(validateExtraParams(tooMany).ok).toBe(false);

    const tooLong = { big: 'x'.repeat(2001) };
    expect(validateExtraParams(tooLong).ok).toBe(false);
  });
});

describe('parseExtraParams（读路径）', () => {
  it('空/非法/非对象一律降级为 undefined，不抛错', () => {
    expect(parseExtraParams(undefined)).toBeUndefined();
    expect(parseExtraParams(null)).toBeUndefined();
    expect(parseExtraParams('')).toBeUndefined();
    expect(parseExtraParams('not json')).toBeUndefined();
    expect(parseExtraParams('[1,2]')).toBeUndefined();
    expect(parseExtraParams('"str"')).toBeUndefined();
    expect(parseExtraParams('null')).toBeUndefined();
  });

  it('合法 JSON 对象解析为对象', () => {
    expect(parseExtraParams('{"enable_thinking": false}')).toEqual({ enable_thinking: false });
    expect(parseExtraParams('{"thinking":{"type":"disabled"}}')).toEqual({ thinking: { type: 'disabled' } });
  });
});
