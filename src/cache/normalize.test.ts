import { describe, it, expect } from 'vitest';
import { normalizeQuestion, normalizeAndHash } from './normalize';

describe('normalizeQuestion', () => {
  it('等价写法归一化为同一结果（缓存命中前提）', () => {
    // 注：+ - = 等数学符号不剥离（保留区分度），仅空白/标点/大小写归一
    expect(normalizeQuestion('What is 2 + 2 ?')).toBe(normalizeQuestion('what is 2+2?'));
  });

  it('去除 HTML 标签与实体', () => {
    expect(normalizeQuestion('<p>题目<br/>内容</p>')).toBe(normalizeQuestion('题目 内容'));
    expect(normalizeQuestion('A&nbsp;B')).toBe(normalizeQuestion('AB'));
  });

  it('去除【题型】标记与分值标记（半角/全角）', () => {
    expect(normalizeQuestion('【单选题】下列哪个正确')).toBe(normalizeQuestion('下列哪个正确'));
    expect(normalizeQuestion('(5分) 题目')).toBe(normalizeQuestion('题目'));
    expect(normalizeQuestion('（5分）题目')).toBe(normalizeQuestion('题目'));
  });

  it('去除中英文标点与所有空白（含全角空格）', () => {
    expect(normalizeQuestion('氢　氧化钠，是。碱！')).toBe(normalizeQuestion('氢氧化钠是碱'));
    expect(normalizeQuestion("it's (ok) [x] {y}")).toBe(normalizeQuestion('itsokxy'));
  });

  it('大写转小写', () => {
    expect(normalizeQuestion('ABC')).toBe('abc');
  });

  it('只含标记/标点/空白时归一化为空串', () => {
    expect(normalizeQuestion('【单选题】（5分）')).toBe('');
    expect(normalizeQuestion('???')).toBe('');
    expect(normalizeQuestion('　 \n\t')).toBe('');
  });
});

describe('normalizeAndHash', () => {
  it('返回 64 位十六进制 SHA-256，且等价题目哈希一致', async () => {
    const a = await normalizeAndHash('中国的首都是哪里？');
    const b = await normalizeAndHash('中国 的首都是哪里');
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.normalized).not.toBe('');
    expect(a.hash).toBe(b.hash);
  });

  it('空串题目哈希为 SHA-256("")（调用方需据此拒绝空归一化输入）', async () => {
    const { hash } = await normalizeAndHash('???');
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
