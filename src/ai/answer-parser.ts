import type { QuestionType } from './types';

/** 判断是否为判断题答案 */
function isJudgementAnswer(answer: string): boolean {
  return /^(对|错|正确|错误|是|否|true|false|√|×|T|F|yes|no)$/i.test(answer.trim());
}

/**
 * 拒答/空答案判定（入库门槛）：命中则不写入题库缓存、对外返回未找到。
 *
 * 拒答文本一旦入库会永久污染缓存——该题此后永远直接命中拒答“答案”，不再走 AI。
 * 判定规则：
 * - 空答案：模型未给出任何内容
 * - 标准化拒答短语「题目不完整」（系统提示词规则 9 约定的输出形态）
 * - 短答案（≤40 字符）中的典型拒答措辞；长答案多为正常作答内容（如解析里含“无法确定”字样），不误伤
 *
 * 已知取舍：≤40 字且恰含拒答措辞的合法答案（如阅读理解选项文本「无法确定」）会被误拦，
 * 代价仅是“不入库 + 本次返回未找到”（下次重问会再走 AI），远小于毒缓存的永久污染。
 */
const REFUSAL_MAX_LEN = 40;
const REFUSAL_PATTERNS: RegExp[] = [
  /题目不完整/,                                                    // 标准化拒答短语（prompt 规则 9）
  /(无法|不能|难以)(确定|判断|回答|作答|提供|给出)/,                // 无法确定/无法回答/难以判断…
  /无法(从|根据|通过|基于)/,                                      // 无法从题目中获得/根据图片无法…
  /信息不足|依据不足|条件不足/,                                    // 信息不足，无法…
  /没有(足够|相关|明确|完整)的?(信息|内容|依据|上下文|题目)/,
  /无法(理解|辨认|看清|查看|看到|识别|读取|获取|分析)(题|图|文|内容|图片)?/, // 无法理解题意/无法识别图片…
  /看不懂|不知道/,
];

export function isRefusalAnswer(answer: string): boolean {
  const a = (answer || '').trim();
  if (!a) return true;
  if (a.length > REFUSAL_MAX_LEN) return false;
  return REFUSAL_PATTERNS.some((re) => re.test(a));
}

/** 从 AI 响应中提取纯答案 */
export function parseAIAnswer(raw: string, type?: QuestionType): string {
  let answer = raw.trim();

  // 1. 提取 markdown 代码块内容（而非整段删除，避免答案被吞空）
  answer = answer.replace(/```(?:[a-zA-Z0-9_-]*\n)?([\s\S]*?)```/g, '$1').trim();

  // 2. 去除常见前缀
  answer = answer.replace(/^(答案[是为：:]*|正确答案[是为：:]*|解析[：:])\s*/gi, '').trim();

  // 3. 去除换行（答案必须是单行）
  answer = answer.replace(/\n/g, ' ').trim();

  // 4. 如果是选择题且答案以字母开头，规范化
  if ((type === 'single' || type === 'multiple' || !type) && /^[A-Z]/i.test(answer)) {
    // 未指定题型时，TRUE/FALSE/T/F 等判断题式单词不拆字母（否则 "T" → "T#R#U#E"），交给下方判断题归一化
    const skipForJudgement = !(type === 'single' || type === 'multiple') && isJudgementAnswer(answer);
    // 如果答案只是字母组合（如 "AB" 或 "A, B, C"）
    if (!skipForJudgement && answer.replace(/[,，、\s#]/g, '').match(/^[A-Z]+$/i)) {
      const letters = answer.match(/[A-Z]/gi);
      if (letters && letters.length > 0) {
        return letters.join('#').toUpperCase();
      }
    }
  }

  // 5. 判断题规范化（整串匹配，避免"正确率"等误命中）
  if (type === 'judgement' || isJudgementAnswer(answer)) {
    const j = answer.trim();
    if (/^(对|正确|是|true|√|T|yes)$/i.test(j)) return '正确';
    if (/^(错|错误|否|false|×|F|no)$/i.test(j)) return '错误';
  }

  return answer;
}
