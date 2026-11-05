import { describe, it, expect } from 'vitest';
import { normalizeQuestionType } from './question-type';
import { parseAIAnswer } from './answer-parser';

describe('normalizeQuestionType（OCS 5.x type=unknown 折叠）', () => {
  it('四种标准题型原样保留', () => {
    expect(normalizeQuestionType('single')).toBe('single');
    expect(normalizeQuestionType('multiple')).toBe('multiple');
    expect(normalizeQuestionType('judgement')).toBe('judgement');
    expect(normalizeQuestionType('completion')).toBe('completion');
  });

  it("OCS 5.x 缺省值 'unknown' → undefined（不污染提示词与题库 type）", () => {
    expect(normalizeQuestionType('unknown')).toBeUndefined();
    expect(normalizeQuestionType('UNKNOWN')).toBeUndefined();
    expect(normalizeQuestionType('')).toBeUndefined();
    expect(normalizeQuestionType(undefined)).toBeUndefined();
    expect(normalizeQuestionType(null)).toBeUndefined();
  });

  it('中文与常见别名归一化', () => {
    expect(normalizeQuestionType('单选题')).toBe('single');
    expect(normalizeQuestionType('多项选择题')).toBe('multiple');
    expect(normalizeQuestionType('判断题')).toBe('judgement');
    expect(normalizeQuestionType('填空题')).toBe('completion');
    expect(normalizeQuestionType('single_choice')).toBe('single');
    expect(normalizeQuestionType('True/False')).toBe('judgement');
  });

  it('拼写变体 judge/judgment/multi 归一到标准值', () => {
    expect(normalizeQuestionType('judge')).toBe('judgement');
    expect(normalizeQuestionType('judgment')).toBe('judgement');
    expect(normalizeQuestionType('multi')).toBe('multiple');
  });

  it('无法识别的题型 → undefined（保持“未指定”语义）', () => {
    expect(normalizeQuestionType('essay')).toBeUndefined();
    expect(normalizeQuestionType('abc123')).toBeUndefined();
  });
});

describe('parseAIAnswer 对 type=unknown 的行为（OCS 5.x 回归）', () => {
  it("'unknown' 不再跳过字母拆分：多选答案仍归一化为 A#B", () => {
    expect(parseAIAnswer('AB', 'unknown')).toBe('A#B');
    expect(parseAIAnswer('A, B, C', 'unknown')).toBe('A#B#C');
  });

  it('未指定题型/标准题型行为不变', () => {
    expect(parseAIAnswer('AB', undefined)).toBe('A#B');
    expect(parseAIAnswer('AB', 'multiple')).toBe('A#B');
    expect(parseAIAnswer('A', 'single')).toBe('A');
  });

  it("'unknown' 下判断题式单词仍不拆字母（T/F/TRUE/FALSE）", () => {
    expect(parseAIAnswer('T', 'unknown')).toBe('正确');
    expect(parseAIAnswer('FALSE', 'unknown')).toBe('错误');
  });

  it('中文题型同样生效', () => {
    expect(parseAIAnswer('A、B', '多选题')).toBe('A#B');
    expect(parseAIAnswer('对', '判断题')).toBe('正确');
  });
});
