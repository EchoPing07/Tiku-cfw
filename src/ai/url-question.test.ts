import { describe, it, expect } from 'vitest';
import {
  classifyUrlQuestionMode,
  parseUrlOptions,
  buildUrlOptionMapForMode,
  buildUrlQuestionPromptParts,
  extractAnswerRaw,
  resolveUrlAnswer,
} from './url-question';

describe('classifyUrlQuestionMode：题型推断（不盲猜原则）', () => {
  it('中英文关键词包含匹配', () => {
    expect(classifyUrlQuestionMode('completion', '')).toBe('open');
    expect(classifyUrlQuestionMode('填空题', '')).toBe('open');
    expect(classifyUrlQuestionMode('简答', '')).toBe('open');
    expect(classifyUrlQuestionMode('multiple', '')).toBe('multiple');
    expect(classifyUrlQuestionMode('多选题', '')).toBe('multiple');
    expect(classifyUrlQuestionMode('judgement', '')).toBe('judgement');
    expect(classifyUrlQuestionMode('判断', '')).toBe('judgement');
    expect(classifyUrlQuestionMode('single', '')).toBe('single');
    expect(classifyUrlQuestionMode('单选题', '')).toBe('single');
  });

  it('type 空且能解析出 ≥2 个带标签选项 → single', () => {
    expect(classifyUrlQuestionMode(undefined, 'A. 甲\nB. 乙')).toBe('single');
    expect(classifyUrlQuestionMode('', '1. 甲\n2. 乙')).toBe('single');
  });

  it('type 空且解析不出选项块 → open（不默认按选择题，不给模型编造 A/B/C 的机会）', () => {
    expect(classifyUrlQuestionMode(undefined, undefined)).toBe('open');
    expect(classifyUrlQuestionMode(undefined, '')).toBe('open');
    expect(classifyUrlQuestionMode(undefined, '一段无标签的材料文本')).toBe('open');
  });
});

describe('parseUrlOptions：选项块解析', () => {
  it('字母标签优先于数字标签；字母块激活后，块内其他行（含数字行）均归续行', () => {
    const m = parseUrlOptions('A. 甲\n续行内容\nB. 乙\n1. 数字项\nC. 丙');
    expect([...m.entries()]).toEqual([
      ['1', '甲\n续行内容'],
      ['2', '乙\n1. 数字项'],
      ['3', '丙'],
    ]);
  });

  it('仅数字标签也可解析', () => {
    const m = parseUrlOptions('1. 甲\n2. 乙\n3. 丙');
    expect([...m.keys()]).toEqual(['1', '2', '3']);
  });

  it('preferLabeledOnly：无标签时不按行拆（type 推断用）', () => {
    expect(parseUrlOptions('甲\n乙', { preferLabeledOnly: true }).size).toBe(0);
  });

  it('allowLineFallback：明确选择题时无标签也可按行拆', () => {
    const m = parseUrlOptions('甲\n乙', { allowLineFallback: true });
    expect([...m.entries()]).toEqual([
      ['1', '甲'],
      ['2', '乙'],
    ]);
  });
});

describe('extractAnswerRaw：取最后一次 ANSWER 匹配', () => {
  it('兼容草稿与终稿多次输出', () => {
    expect(extractAnswerRaw('分析…ANSWER: 1\n复核后更正 ANSWER: 2')).toBe('2');
    expect(extractAnswerRaw('ANSWER: B')).toBe('B');
    expect(extractAnswerRaw('没有答案行')).toBe('');
  });
});

describe('resolveUrlAnswer：编号/字母 → 选项正文映射', () => {
  const opts = 'A. 甲\nB. 乙\nC. 丙';

  it('数字编号映射选项正文', () => {
    expect(resolveUrlAnswer('ANSWER: 2', buildUrlOptionMapForMode('single', opts), 'single')).toBe('乙');
  });

  it('字母映射选项正文（单选）', () => {
    expect(resolveUrlAnswer('ANSWER: B', buildUrlOptionMapForMode('single', opts), 'single')).toBe('乙');
  });

  it('多选：字母串 AC 拆开映射，以 # 连接（本项目协议，非 ZError 的 ###）', () => {
    expect(resolveUrlAnswer('ANSWER: AC', buildUrlOptionMapForMode('multiple', opts), 'multiple')).toBe('甲#丙');
  });

  it('多选：空格/逗号/顿号/和与及分隔均可', () => {
    const m = buildUrlOptionMapForMode('multiple', opts);
    expect(resolveUrlAnswer('ANSWER: 1 3', m, 'multiple')).toBe('甲#丙');
    expect(resolveUrlAnswer('ANSWER: 1，3', m, 'multiple')).toBe('甲#丙');
    expect(resolveAnswer('ANSWER: 1和3')).toBe('甲#丙');
    function resolveAnswer(s: string) {
      return resolveUrlAnswer(s, m, 'multiple');
    }
  });

  it('数字串 13 在每位都能命中时拆 1、3', () => {
    const m = buildUrlOptionMapForMode('multiple', opts);
    expect(resolveUrlAnswer('ANSWER: 13', m, 'multiple')).toBe('甲#丙');
  });

  it('已是「B. 选项正文」形态：剥前缀并校验命中', () => {
    expect(resolveUrlAnswer('ANSWER: B. 乙', buildUrlOptionMapForMode('single', opts), 'single')).toBe('乙');
  });

  it('映射失败回退去前缀原文，绝不返回空', () => {
    expect(resolveUrlAnswer('ANSWER: Z', buildUrlOptionMapForMode('single', opts), 'single')).toBe('Z');
    expect(resolveUrlAnswer('ANSWER: 9', buildUrlOptionMapForMode('single', opts), 'single')).toBe('9');
  });

  it('open 模式：直接返回原文（不映射）', () => {
    expect(resolveUrlAnswer('ANSWER: 42', new Map(), 'open')).toBe('42');
  });

  it('judgement 模式：返回原文', () => {
    expect(resolveUrlAnswer('ANSWER: 正确', new Map(), 'judgement')).toBe('正确');
  });

  it('无 ANSWER 行返回空（调用方回退通用解析）', () => {
    expect(resolveUrlAnswer('答案：乙', buildUrlOptionMapForMode('single', opts), 'single')).toBe('');
  });

  it('取最后一次 ANSWER（模型先草稿后终稿）', () => {
    expect(resolveUrlAnswer('ANSWER: 1\n更正：ANSWER: 2', buildUrlOptionMapForMode('single', opts), 'single')).toBe(
      '乙'
    );
  });
});

describe('buildUrlQuestionPromptParts：协议提示词', () => {
  it('选择模式：选项重新编号，answerRule 含编号示例', () => {
    const m = buildUrlOptionMapForMode('single', 'A. 甲\nB. 乙');
    const { optionsText, answerRule } = buildUrlQuestionPromptParts('single', 'A. 甲\nB. 乙', m);
    expect(optionsText).toContain('1. 甲');
    expect(optionsText).toContain('2. 乙');
    expect(answerRule).toContain('ANSWER: 2');
  });

  it('open 模式：选项作为补充材料保留（不编号，防当作选项作答）', () => {
    const { optionsText, answerRule } = buildUrlQuestionPromptParts('open', '阅读材料正文', new Map());
    expect(optionsText).toContain('【补充材料】');
    expect(optionsText).toContain('阅读材料正文');
    expect(answerRule).toContain('不要编造 A/B/C');
  });

  it('judgement / 未解析出选项的选择题：选项同样以补充材料保留（本项目对 ZError 的增强）', () => {
    const j = buildUrlQuestionPromptParts('judgement', '题干附注', new Map());
    expect(j.optionsText).toContain('【补充材料】');
    const s = buildUrlQuestionPromptParts('single', '无标签材料', new Map());
    expect(s.optionsText).toContain('【补充材料】');
    expect(s.answerRule).toContain('直接写出完整答案内容');
  });

  it('多选规则要求列出全部编号', () => {
    const m = buildUrlOptionMapForMode('multiple', 'A. 甲\nB. 乙');
    const { answerRule } = buildUrlQuestionPromptParts('multiple', 'A. 甲\nB. 乙', m);
    expect(answerRule).toContain('全部正确选项编号');
    expect(answerRule).toContain('ANSWER: 1 3');
  });
});
