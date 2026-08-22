import { describe, it, expect } from 'vitest';
import { parseAIAnswer } from './answer-parser';

describe('parseAIAnswer', () => {
  it('提取 markdown 代码块中的内容', () => {
    expect(parseAIAnswer('```\n正确答案：A\n```')).toBe('A');
    expect(parseAIAnswer('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('去除"答案/正确答案/解析"前缀', () => {
    expect(parseAIAnswer('答案是：A')).toBe('A');
    expect(parseAIAnswer('正确答案为北京')).toBe('北京');
    expect(parseAIAnswer('解析：选 C')).toBe('选 C'); // 仅"解析："前缀被去除，正文保留
  });

  it('多行答案合并为单行（空格分隔）', () => {
    expect(parseAIAnswer('第一行\n第二行')).toBe('第一行 第二行');
  });

  it('选择题字母组合规范化为 # 分隔大写', () => {
    expect(parseAIAnswer('A')).toBe('A');
    expect(parseAIAnswer('ab')).toBe('A#B');
    expect(parseAIAnswer('A, B、C')).toBe('A#B#C');
    expect(parseAIAnswer('a、b')).toBe('A#B');
    expect(parseAIAnswer('AC', 'multiple')).toBe('A#C');
  });

  it('字母开头的正文不被误拆', () => {
    expect(parseAIAnswer('Apple 是一种水果')).toBe('Apple 是一种水果');
  });

  it('判断题归一化为 正确/错误', () => {
    expect(parseAIAnswer('对')).toBe('正确');
    expect(parseAIAnswer('true')).toBe('正确');
    expect(parseAIAnswer('TRUE')).toBe('正确'); // 回归：曾被字母组合逻辑拆成 T#R#U#E
    expect(parseAIAnswer('√')).toBe('正确');
    expect(parseAIAnswer('T')).toBe('正确');
    expect(parseAIAnswer('yes')).toBe('正确');
    expect(parseAIAnswer('错')).toBe('错误');
    expect(parseAIAnswer('false')).toBe('错误');
    expect(parseAIAnswer('FALSE')).toBe('错误');
    expect(parseAIAnswer('×')).toBe('错误');
    expect(parseAIAnswer('F')).toBe('错误');
    expect(parseAIAnswer('no')).toBe('错误');
  });

  it('显式选择题类型下 T/F 仍按选项字母处理', () => {
    expect(parseAIAnswer('T', 'single')).toBe('T');
    expect(parseAIAnswer('F', 'multiple')).toBe('F');
  });

  it('包含判断词的整串不被误判（"正确率"仍保留原文）', () => {
    expect(parseAIAnswer('正确率')).toBe('正确率');
  });

  it('未指定题型时也做选择题/判断题规范化', () => {
    expect(parseAIAnswer('B')).toBe('B');
    expect(parseAIAnswer('是')).toBe('正确');
  });

  it('普通文本答案原样返回（仅去空白）', () => {
    expect(parseAIAnswer('  北京  ')).toBe('北京');
  });
});
