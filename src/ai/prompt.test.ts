import { describe, it, expect } from 'vitest';
import { buildVisionMessage } from './prompt';

/** 提取 content 中 image_url 的 url 列表（保序） */
const imageUrls = (parts: ReturnType<typeof buildVisionMessage>): string[] =>
  parts.filter((p) => p.type === 'image_url').map((p) => p.image_url!.url);

describe('buildVisionMessage：图文交错', () => {
  it('图片保持题目原文位置（text/image 交替，模型能对上“如图”指哪张）', () => {
    const parts = buildVisionMessage(
      '前文 https://x.com/a.png 中文 https://x.com/b.png 后文',
      undefined,
      new Map(),
      [],
      undefined
    );
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'text', 'image_url', 'text']);
    expect(parts[0].text).toContain('前文');
    expect(parts[1].image_url!.url).toBe('https://x.com/a.png');
    expect(parts[3].image_url!.url).toBe('https://x.com/b.png');
  });

  it('imageMap 命中用 data URL（Worker 抓取成功），detail=high', () => {
    const map = new Map([['https://x/a.png', 'data:image/png;base64,AAA']]);
    const parts = buildVisionMessage('题 https://x/a.png', undefined, map, [], undefined);
    const img = parts.find((p) => p.type === 'image_url')!;
    expect(img.image_url).toEqual({ url: 'data:image/png;base64,AAA', detail: 'high' });
  });

  it('imageMap 缺项回退原始 URL（Worker 抓取失败，厂商代抓兜底）', () => {
    const parts = buildVisionMessage('题 https://x/a.png', undefined, new Map(), [], undefined);
    expect(imageUrls(parts)).toEqual(['https://x/a.png']);
  });

  it('extraImages（客户端 images 数组、不在文本中）追加在末尾', () => {
    const parts = buildVisionMessage(
      '题 https://x/a.png',
      undefined,
      new Map(),
      ['https://extra/1.png'],
      undefined
    );
    const urls = imageUrls(parts);
    expect(urls).toEqual(['https://x/a.png', 'https://extra/1.png']);
    // 末尾仍保留 ANSWER 协议指令文本？——指令在文本流内，extra 图追加在最后
    const last = parts[parts.length - 1];
    expect(last.type).toBe('image_url');
  });

  it('选项含图：交错同样生效（选项文本进入分段）', () => {
    const parts = buildVisionMessage('题干', 'A. <img src="https://x/opt1.png">\nB. 乙', new Map(), [], undefined);
    expect(imageUrls(parts)).toEqual(['https://x/opt1.png']);
  });

  it('ANSWER 协议指令注入文本流（题目之后）', () => {
    const parts = buildVisionMessage('题干内容', undefined, new Map(), [], undefined);
    const text = parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    expect(text).toContain('题目：题干内容');
    expect(text).toContain('ANSWER: <答案>');
  });

  it('type 传递时输出题型行', () => {
    const parts = buildVisionMessage('题干', undefined, new Map(), [], 'single');
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    expect(text).toContain('题目类型：单选题');
  });

  it('选择模式：选项重新编号（消除原始 A./B. 混乱）', () => {
    const parts = buildVisionMessage('题干', 'A. 甲\nB. 乙', new Map(), [], 'single');
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    expect(text).toContain('1. 甲');
    expect(text).toContain('2. 乙');
  });

  it('Tier 2 URL 保留在文本段（不转 image 分片）', () => {
    const parts = buildVisionMessage('见 https://x.com/doc/page1 说明', undefined, new Map(), [], undefined);
    expect(imageUrls(parts)).toEqual([]);
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
    expect(text).toContain('https://x.com/doc/page1');
  });

  it('无图纯文本题目（仅 images 数组）：单文本段 + 末尾图片', () => {
    const parts = buildVisionMessage('题干', undefined, new Map(), ['https://only/1.png'], undefined);
    expect(parts[0].type).toBe('text');
    expect(parts[parts.length - 1].type).toBe('image_url');
  });
});
