import type { QuestionType } from './types';

/** 判断是否为判断题答案 */
function isJudgementAnswer(answer: string): boolean {
  return /^(对|错|正确|错误|是|否|true|false|√|×|T|F|yes|no)$/i.test(answer.trim());
}

/** 从 AI 响应中提取纯答案 */
export function parseAIAnswer(raw: string, type?: QuestionType): string {
  let answer = raw.trim();

  // 1. 去除 markdown 代码块
  answer = answer.replace(/```[\s\S]*?```/g, '').trim();

  // 2. 去除常见前缀
  answer = answer.replace(/^(答案[是为：:]*|正确答案[是为：:]*|解析[：:])\s*/gi, '').trim();

  // 3. 去除换行（答案必须是单行）
  answer = answer.replace(/\n/g, ' ').trim();

  // 4. 如果是选择题且答案以字母开头，规范化
  if ((type === 'single' || type === 'multiple' || !type) && /^[A-Z]/i.test(answer)) {
    // 如果答案只是字母组合（如 "AB" 或 "A, B, C"）
    if (answer.replace(/[,，、\s#]/g, '').match(/^[A-Z]+$/i)) {
      const letters = answer.match(/[A-Z]/gi);
      if (letters && letters.length > 0) {
        return letters.join('#').toUpperCase();
      }
    }
  }

  // 5. 判断题规范化
  if (type === 'judgement' || isJudgementAnswer(answer)) {
    if (/对|正确|是|true|√|T$|yes/i.test(answer)) return '正确';
    if (/错|错误|否|false|×|F$|no/i.test(answer)) return '错误';
  }

  return answer;
}
