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

describe('buildOCSConfig：OCS 5.x 图片题优化 v2 协议', () => {
  const arr = JSON.parse(buildOCSConfig({ siteName: '题库', origin: 'https://t.example.com', apiKey: 'tk_abc' }));
  const data = arr[0].data;

  /** OCS 官方判定函数（answerer-env.ts isAnswererWrapperSupportImageOptimize）的等价实现 */
  const PLACEHOLDERS = ['${images}', '${suggestion_title}', '${suggestion_options}'];
  const ENV_REF = /(^|[^\w$])(images|suggestion_title|suggestion_options)(?![\w$])/;
  const supportsImageOptimize = (wrapper: any): boolean => {
    if (String(wrapper.method || 'get').toLowerCase() !== 'post') return false;
    for (const value of Object.values(wrapper.data || {})) {
      if (typeof value === 'string') {
        if (PLACEHOLDERS.some((p) => value.includes(p))) return true;
      } else if (value && typeof value === 'object' && typeof (value as any).handler === 'string') {
        if (ENV_REF.test((value as any).handler)) return true;
      }
    }
    return false;
  };

  it('配置被 OCS 判定为“支持图片题优化”（不再弹不支持警告）', () => {
    expect(supportsImageOptimize(arr[0])).toBe(true);
  });

  it('data 声明 images / suggestion_title / suggestion_options 三个字段', () => {
    expect(Object.keys(data)).toEqual(
      expect.arrayContaining(['title', 'type', 'options', 'images', 'suggestion_title', 'suggestion_options'])
    );
  });

  it('images 用 handler 取值：保住 base64 数组形态（占位符会被拼成字符串）', () => {
    expect(typeof data.images).toBe('object');
    const fn = new Function(data.images.handler)();
    const images = ['data:image/png;base64,AA,BB', 'data:image/png;base64,CC'];
    expect(fn({ images })).toEqual(images); // 逗号不被拼成一串
  });

  it('老版本 OCS 无 env.images 时返回 undefined（字段从 JSON 中消失，不留 "undefined"）', () => {
    const fn = new Function(data.images.handler)();
    expect(fn({})).toBeUndefined();
    expect(JSON.stringify({ images: fn({}) })).toBe('{}');
  });

  it('suggestion_* 同样用 handler 取值', () => {
    const fnTitle = new Function(data.suggestion_title.handler)();
    const fnOpts = new Function(data.suggestion_options.handler)();
    const env = { suggestion_title: '题 [图片1]', suggestion_options: 'A. [图片2]' };
    expect(fnTitle(env)).toBe('题 [图片1]');
    expect(fnOpts(env)).toBe('A. [图片2]');
  });

  it('保留 title/type/options 占位符（OCS 老链路仍可用）', () => {
    expect(data.title).toBe('${title}');
    expect(data.type).toBe('${type}');
    expect(data.options).toBe('${options}');
  });
});
