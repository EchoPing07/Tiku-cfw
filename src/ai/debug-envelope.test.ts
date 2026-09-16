import { describe, it, expect } from 'vitest';
import {
  maskKey,
  buildRequestEnvelope,
  buildResponseEnvelope,
  appendAttempt,
} from './debug-envelope';
import { weightedRandomOrder } from './dispatcher';
import type { AttemptRecord } from './types';

describe('maskKey', () => {
  it('长 Key 保留前 6 后 4', () => {
    expect(maskKey('sk-1234567890abcdef')).toBe('sk-123...cdef');
  });
  it('短 Key 只留前 4 + 掩码，不泄露全文', () => {
    const out = maskKey('shortkey');
    expect(out.startsWith('shor')).toBe(true);
    expect(out).not.toContain('rtkey');
  });
  it('空串返回空', () => {
    expect(maskKey('')).toBe('');
  });
});

describe('buildRequestEnvelope', () => {
  const base = {
    url: 'https://api.openai.com/v1/chat/completions',
    channel: 'OpenAI 文本',
    model: 'gpt-4o-mini',
    apiKey: 'sk-1234567890abcdef',
    httpStatus: 401,
    errorType: 'http_auth' as const,
  };

  it('元数据完整（永不截断）且 Key 脱敏', () => {
    const s = buildRequestEnvelope({ ...base, rawRequestBody: '{"model":"m"}' });
    const env = JSON.parse(s);
    expect(env.v).toBe(1);
    expect(env.url).toBe(base.url);
    expect(env.channel).toBe(base.channel);
    expect(env.model).toBe(base.model);
    expect(env.key).toBe('sk-123...cdef');
    expect(env.http_status).toBe(401);
    expect(env.error_type).toBe('http_auth');
    expect(env.truncated).toBe(false);
    expect(s).not.toContain('sk-1234567890abcdef'); // 完整密钥绝不落库
  });

  it('image_url 折叠为长度占位（视觉请求不再撑爆信封）', () => {
    const raw = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: [
          { type: 'text', text: '看图答题' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'x'.repeat(20000) } },
        ] },
      ],
    });
    const s = buildRequestEnvelope({ ...base, rawRequestBody: raw });
    const env = JSON.parse(s);
    // 20KB 图片折叠成占位符后，信封应远小于上限且无需截断
    expect(s.length).toBeLessThan(2000);
    expect(env.body).toContain('<<omitted: ');
    expect(env.body).toContain(' chars>>');
    expect(env.truncated).toBe(false); // 折叠后无需截断
  });

  it('超长非图片 body 截断并置 truncated=true', () => {
    const raw = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(20000) }] });
    const s = buildRequestEnvelope({ ...base, rawRequestBody: raw });
    const env = JSON.parse(s);
    expect(env.truncated).toBe(true);
    expect(env.body).toContain('...[truncated]');
  });
});

describe('buildResponseEnvelope', () => {
  it('短响应完整保留', () => {
    const s = buildResponseEnvelope({ httpStatus: 200, rawBody: '{"ok":true}' });
    const env = JSON.parse(s);
    expect(env.v).toBe(1);
    expect(env.http_status).toBe(200);
    expect(env.truncated).toBe(false);
    expect(env.body).toBe('{"ok":true}');
  });
  it('超长响应截断并标记', () => {
    const s = buildResponseEnvelope({ httpStatus: 200, rawBody: 'x'.repeat(30000) });
    const env = JSON.parse(s);
    expect(env.truncated).toBe(true);
    expect(env.body.endsWith('...[truncated]')).toBe(true);
  });
});

describe('appendAttempt', () => {
  const mk = (seq: number, error?: string): AttemptRecord => ({
    seq, channel: 'c' + seq, model: 'm', key: 'sk-1...abcd',
    ok: false, http_status: 401, error_type: 'http_auth',
    error: error ?? null, latency_ms: 100,
  });

  it('按序追加且错误摘要截断至 512', () => {
    let list = appendAttempt([], mk(1, 'x'.repeat(1000)));
    list = appendAttempt(list, mk(2));
    expect(list).toHaveLength(2);
    expect(list[0].seq).toBe(1);
    expect(list[0].error!.length).toBe(512);
  });

  it('整体超限时收缩而非丢弃全部', () => {
    let list: AttemptRecord[] = [];
    for (let i = 1; i <= 30; i++) {
      list = appendAttempt(list, mk(i, 'e'.repeat(400)));
    }
    // 全部保留或部分收缩，但不为空且不超过太多
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(8192); // 收缩后的合理上界
  });
});

describe('weightedRandomOrder', () => {
  it('返回全排列（不放回、无丢失、无重复）', () => {
    const items = [1, 2, 3, 4, 5].map(id => ({ id, weight: id }));
    const out = weightedRandomOrder(items);
    expect(out).toHaveLength(5);
    expect(new Set(out.map(o => o.id)).size).toBe(5);
  });

  it('单元素确定性返回', () => {
    expect(weightedRandomOrder([{ id: 1, weight: 5 }])).toEqual([{ id: 1, weight: 5 }]);
  });

  it('空输入返回空', () => {
    expect(weightedRandomOrder([])).toEqual([]);
  });

  it('高权重条目统计上更常被优先抽中', () => {
    const items = [
      { id: 'high', weight: 20 },
      { id: 'low', weight: 1 },
    ];
    let firstHigh = 0;
    for (let i = 0; i < 1000; i++) {
      if (weightedRandomOrder(items)[0].id === 'high') firstHigh++;
    }
    // 20:1 → 期望约 95%；放宽边界防偶发
    expect(firstHigh).toBeGreaterThan(850);
    expect(firstHigh).toBeLessThan(1000);
  });
});
