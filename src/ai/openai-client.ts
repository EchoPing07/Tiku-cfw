import type { AIRequest, AIResult } from './types';
import { AIError } from './types';

/** 调用 OpenAI 兼容接口（/chat/completions） */
export async function callOpenAI(req: AIRequest): Promise<AIResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), req.timeout * 1000);

  const url = req.baseUrl.replace(/\/$/, '') + '/chat/completions';

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
  };

  const rawRequest = JSON.stringify(body, null, 2);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // fetch 本身抛异常（DNS 失败、连接拒绝、超时 abort 等）
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new AIError('AI 请求超时', rawRequest);
    }
    throw new AIError(
      `AI 网络请求失败: ${err instanceof Error ? err.message : String(err)}`,
      rawRequest
    );
  } finally {
    clearTimeout(timeoutId);
  }

  // 读取原始响应文本（无论成功还是失败都可用于调试）
  let responseText: string;
  try {
    responseText = await response.text();
  } catch (err) {
    // response.text() 抛异常（连接中断、响应体读取失败等）
    throw new AIError(
      `AI 响应读取失败: ${err instanceof Error ? err.message : String(err)}`,
      rawRequest
    );
  }

  if (!response.ok) {
    throw new AIError(
      `AI 请求失败 ${response.status}: ${responseText.slice(0, 500)}`,
      rawRequest,
      responseText
    );
  }

  let data: { choices?: Array<{ message?: { content?: string } }>; model?: string };
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new AIError('AI 响应 JSON 解析失败', rawRequest, responseText);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new AIError('AI 返回内容为空', rawRequest, responseText);
  }

  return {
    content: content.trim(),
    model: data.model || req.model,
    rawRequest,
    rawResponse: responseText,
  };
}
