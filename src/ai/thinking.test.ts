import { describe, it, expect } from 'vitest';
import { buildThinkingParams, normalizeThinkingLevel } from './thinking';

describe('normalizeThinkingLevel（写路径校验）', () => {
  it('空输入（undefined/null/空串/空白）归一为 null（清除）', () => {
    expect(normalizeThinkingLevel(undefined)).toEqual({ ok: true, value: null });
    expect(normalizeThinkingLevel(null)).toEqual({ ok: true, value: null });
    expect(normalizeThinkingLevel('')).toEqual({ ok: true, value: null });
    expect(normalizeThinkingLevel('  ')).toEqual({ ok: true, value: null });
  });

  it('四档等级通过并去空白', () => {
    for (const lv of ['off', 'low', 'medium', 'high']) {
      expect(normalizeThinkingLevel(lv)).toEqual({ ok: true, value: lv });
    }
    expect(normalizeThinkingLevel(' high ')).toEqual({ ok: true, value: 'high' });
  });

  it('白名单外的值拒绝', () => {
    expect(normalizeThinkingLevel('minimal').ok).toBe(false);
    expect(normalizeThinkingLevel('HIGH').ok).toBe(false); // 大小写敏感
    expect(normalizeThinkingLevel(3).ok).toBe(false);
  });
});

describe('buildThinkingParams（读路径映射）', () => {
  it('未设置等级不附加任何参数', () => {
    expect(buildThinkingParams('qwen3-max', null)).toBeUndefined();
    expect(buildThinkingParams('gpt-4o', '')).toBeUndefined();
    expect(buildThinkingParams('o4-mini', undefined)).toBeUndefined();
  });

  it('Qwen → enable_thinking 开关（厂商无分档，非 off 一律显式开启）', () => {
    expect(buildThinkingParams('qwen3-max', 'off')).toEqual({ enable_thinking: false });
    expect(buildThinkingParams('Qwen3-VL-Plus', 'high')).toEqual({ enable_thinking: true });
    expect(buildThinkingParams('qwen-plus', 'low')).toEqual({ enable_thinking: true });
  });

  it('GLM / 豆包 → thinking.type 开关（厂商无分档）', () => {
    expect(buildThinkingParams('glm-4.6', 'off')).toEqual({ thinking: { type: 'disabled' } });
    expect(buildThinkingParams('chatglm-4', 'medium')).toEqual({ thinking: { type: 'enabled' } });
    expect(buildThinkingParams('doubao-1-5-thinking-pro', 'low')).toEqual({ thinking: { type: 'enabled' } });
  });

  it('其余模型 → reasoning_effort 分档', () => {
    expect(buildThinkingParams('o4-mini', 'medium')).toEqual({ reasoning_effort: 'medium' });
    expect(buildThinkingParams('gemini-2.5-flash', 'high')).toEqual({ reasoning_effort: 'high' });
    expect(buildThinkingParams('gpt-5-mini', 'low')).toEqual({ reasoning_effort: 'low' });
  });

  it('关闭思考：gpt-5 用 minimal，o 系用 low（o 系不接受 minimal）', () => {
    expect(buildThinkingParams('gpt-5', 'off')).toEqual({ reasoning_effort: 'minimal' });
    expect(buildThinkingParams('o3-mini', 'off')).toEqual({ reasoning_effort: 'low' });
  });

  it('模型 ID 大小写不敏感（qwen 匹配 Qwen3）', () => {
    expect(buildThinkingParams('Qwen3-Max', 'off')).toEqual({ enable_thinking: false });
  });
});
