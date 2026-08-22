import { describe, it, expect } from 'vitest';
import { buildOCSConfig } from './ocs';

describe('buildOCSConfig', () => {
  const config = buildOCSConfig({ siteName: '我的题库', origin: 'https://t.example.com', apiKey: 'tk_abc' });

  it('输出单元素数组的 JSON 字符串', () => {
    const arr = JSON.parse(config);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(1);
    expect(arr[0].name).toBe('我的题库');
  });

  it('URL 指向 /api/search，POST + JSON', () => {
    const arr = JSON.parse(config);
    expect(arr[0].url).toBe('https://t.example.com/api/search');
    expect(arr[0].method).toBe('post');
    expect(arr[0].contentType).toBe('json');
  });

  it('Authorization 头携带 Bearer 密钥', () => {
    const arr = JSON.parse(config);
    expect(arr[0].headers.Authorization).toBe('Bearer tk_abc');
  });

  it('data 字段使用 OCS 模板变量', () => {
    const arr = JSON.parse(config);
    expect(arr[0].data.title).toBe('${title}');
    expect(arr[0].data.type).toBe('${type}');
    expect(arr[0].data.options).toBe('${options}');
  });

  it('handler 按 code===1 返回 [question, answer]', () => {
    const arr = JSON.parse(config);
    const handler = eval(`(${arr[0].handler.replace(/^return /, '')})`);
    expect(handler({ code: 1, question: '题目', answer: 'A' })).toEqual(['题目', 'A']);
    expect(handler({ code: 0 })).toBeUndefined();
  });
});
