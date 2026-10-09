import { splitTextImageParts } from '../utils/question-images';
import { classifyUrlQuestionMode, buildUrlOptionMapForMode, buildUrlQuestionPromptParts } from './url-question';

/** 默认系统提示词 */
export const DEFAULT_SYSTEM_PROMPT = `你是一个专业的题库答题助手。请根据提供的题目和选项，给出正确答案。

## 答题规则

1. 单选题：返回正确选项的内容或字母（如 A）
2. 多选题：多个答案用 # 分隔，如 A#B#C
3. 判断题：返回"正确"或"错误"
4. 填空题：多个空用 # 分隔，如 答案1#答案2#答案3
5. 只返回答案本身，不要任何解释、分析或前缀
6. 不要说"答案是"，直接返回答案内容
7. 如果题目类型未指定，请自行判断题型
8. 如果不确定，返回你最有把握的答案
9. 仅当题目信息不完整或无法理解题意时（如内容缺失、乱码、图片无法辨认），返回：题目不完整，无法作答

## 格式要求

- 选择题答案可以是字母（A）或选项完整内容
- 多选答案必须用 # 分隔
- 判断题只能返回"正确"或"错误"两个词之一
- 填空题多空必须用 # 分隔
- 不要使用 markdown 格式
- 不要换行，答案必须是单行`;

/** 类型中文映射 */
const TYPE_LABELS: Record<string, string> = {
  single: '单选题',
  multiple: '多选题',
  judgement: '判断题',
  completion: '填空题',
};

/** 构建系统提示词 */
export function buildSystemPrompt(customPrompt?: string): string {
  return customPrompt?.trim() ? customPrompt.trim() : DEFAULT_SYSTEM_PROMPT;
}

/** 构建用户消息（纯文本） */
export function buildUserMessage(title: string, type?: string, options?: string): string {
  const lines: string[] = [];

  if (type) {
    lines.push(`题目类型：${TYPE_LABELS[type] || type}`);
  }
  lines.push(`题目：${title}`);

  if (options) {
    lines.push(`选项：`);
    lines.push(options);
  }

  return lines.join('\n');
}

/** 视觉消息 content 分片（types.ts ChatMessage 子结构，带 OpenAI 视觉 detail 精细度） */
export interface VisionContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'high' | 'low' | 'auto' };
}

/** ANSWER 协议指令（注入 user 消息尾部；不动可配置的 system 提示词） */
function visionAnswerInstruction(answerRule: string): string {
  return (
    '\n请仔细分析题目内容与图片（图片按原文位置插入）。' +
    '在回答末尾，严格按照以下格式单独一行给出最终答案：\nANSWER: <答案>\n\n作答规则：\n' +
    answerRule
  );
}

/**
 * 构建视觉模型用户消息（图文交错 + ANSWER 协议）。
 *
 * - 文本按 URL 位置拆成 text / image_url 交替分片，图片保持原文位置，模型能对上
 *   “如图”指的是哪一张；
 * - 选项按模式重新编号（消除 A./B. 与空行序号混乱），或作为补充材料保留；
 * - imageMap：归一化 URL → 已解析 URL（抓取成功为 data URL，失败回退原始 URL 由厂商代抓）；
 * - extraImages：客户端 images 数组中不在题目文本里的图（无位置信息，末尾追加）；
 * - detail: 'high'：公式/图表类小图需高精细度识别。
 */
export function buildVisionMessage(
  title: string,
  options: string | undefined,
  imageMap: Map<string, string>,
  extraImages: string[],
  type?: string,
  patterns?: RegExp[]
): VisionContentPart[] {
  // 题型模式推断（type 缺失时不盲猜：解析不出选项块按开放题处理）
  const mode = classifyUrlQuestionMode(type, options);
  const optionMap = buildUrlOptionMapForMode(mode, options);
  const { optionsText, answerRule } = buildUrlQuestionPromptParts(mode, options || '', optionMap);

  const lines: string[] = [];
  if (type) {
    lines.push(`题目类型：${TYPE_LABELS[type] || type}`);
  }
  lines.push(`题目：${title}`);
  if (optionsText) lines.push(optionsText);
  lines.push(visionAnswerInstruction(answerRule));

  // 完整文本按 URL 位置拆分（图片性 URL → image 分片，其余 URL 留在文本中）
  const parts: VisionContentPart[] = splitTextImageParts(lines.join('\n'), { patterns }).map((p) =>
    p.type === 'text'
      ? { type: 'text' as const, text: p.text }
      : {
          type: 'image_url' as const,
          image_url: { url: imageMap.get(p.url!) ?? p.url!, detail: 'high' as const },
        }
  );

  // 客户端 images 数组中不在题目文本里的图（无位置信息，统一追加在末尾）
  for (const u of extraImages) {
    if (!u) continue;
    parts.push({ type: 'image_url', image_url: { url: imageMap.get(u) ?? u, detail: 'high' } });
  }
  return parts;
}
