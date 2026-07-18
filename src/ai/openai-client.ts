import type { AIRequest, AIResult } from './types';

/** 调用 OpenAI 兼容接口（/chat/completions） */
export async function callOpenAI(req: AIRequest): Promise<AIResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), req.timeout * 1000);

  try {
    const url = req.baseUrl.replace(/\/$/, '') + '/chat/completions';

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`AI 请求失败 ${response.status}: ${errorText.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('AI 返回内容为空');
    }

    return {
      content: content.trim(),
      model: data.model || req.model,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('AI 请求超时');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
