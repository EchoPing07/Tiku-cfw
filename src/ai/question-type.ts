/** 题型归一化（把 OCS / 各平台的题型字符串折叠成本项目认的四种，其余一律视为未指定） */
import type { QuestionType } from './types';

/**
 * 题型别名表（键为小写、去空格/下划线的形态）。
 *
 * OCS 5.x 在题型缺失时不再传 `undefined`，而是传字面量 `'unknown'`
 * （core/answer-wrapper/answer.wrapper.handler.ts：`if (env.type === undefined) env.type = 'unknown'`），
 * 各平台也会直接传中文题型。若不折叠，`'unknown'` 会：
 * ① 拼进提示词（`题目类型：unknown`）；② 让答案归一化跳过多选的 A#B 拆分；
 * ③ 原样写进 questions.type。
 */
const TYPE_ALIASES: Record<string, QuestionType> = {
  single: 'single',
  singlechoice: 'single',
  singlechoicequestion: 'single',
  radio: 'single',
  choice: 'single',
  '单选': 'single',
  '单选题': 'single',
  '单项选择题': 'single',

  multiple: 'multiple',
  multi: 'multiple',
  multichoice: 'multiple',
  multiplechoice: 'multiple',
  multiplechoicequestion: 'multiple',
  checkbox: 'multiple',
  '多选': 'multiple',
  '多选题': 'multiple',
  '多项选择题': 'multiple',

  judgement: 'judgement',
  judgment: 'judgement',
  judge: 'judgement',
  truefalse: 'judgement',
  tf: 'judgement',
  boolean: 'judgement',
  '判断': 'judgement',
  '判断题': 'judgement',
  '是非题': 'judgement',

  completion: 'completion',
  fill: 'completion',
  fillblank: 'completion',
  fillin: 'completion',
  blank: 'completion',
  blanks: 'completion',
  '填空': 'completion',
  '填空题': 'completion',
};

/**
 * 归一化题型：命中别名表返回四种题型之一，其余（含 `'unknown'` / `''` / 未传）返回 undefined。
 * 未识别题型不再作为字符串下传，避免污染提示词与答案格式。
 */
export function normalizeQuestionType(raw: string | null | undefined): QuestionType {
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toLowerCase().replace(/[\s/\\_\-]+/g, '');
  if (!key) return undefined;
  return TYPE_ALIASES[key];
}
