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

/** 构建视觉模型用户消息（含图片） */
export function buildVisionMessage(
  title: string,
  images: string[],
  type?: string,
  options?: string
): Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> {
  const textParts: string[] = [];

  if (type) {
    textParts.push(`题目类型：${TYPE_LABELS[type] || type}`);
  }
  textParts.push(`题目：${title}`);

  if (options) {
    textParts.push(`选项：`);
    textParts.push(options);
  }

  const content: Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> = [
    { type: 'text', text: textParts.join('\n') },
  ];

  for (const url of images) {
    content.push({ type: 'image_url', image_url: { url } });
  }

  return content;
}
