import type { AIRequest, AIResult, AIErrorType, TokenUsage } from './types';
import { AIError } from './types';

/** HTTP 状态码 → 错误分类 */
function httpErrorType(status: number): AIErrorType {
  if (status === 401 || status === 403) return 'http_auth';
  if (status === 429) return 'http_rate';
  if (status === 400) return 'http_bad_request';
  if (status >= 500) return 'http_server';
  return 'http_other';
}

/** 调用 OpenAI 兼容接口（/chat/completions），抛错统一携带分类与状态码 */
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

  let response: Response | undefined;
  let responseText: string;
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
    // 读取原始响应文本（无论成功还是失败都可用于调试）。
    // 与 fetch 放在同一 try 内：超时中止对响应体读取同样生效，避免慢速滴流响应无限挂起
    responseText = await response.text();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new AIError('AI 请求超时', 'timeout', rawRequest, undefined, undefined, null);
    }
    if (response === undefined) {
      // fetch 本身抛异常（DNS 失败、连接拒绝等）——多为 base_url 配错
      throw new AIError(
        `AI 网络请求失败: ${err instanceof Error ? err.message : String(err)}`,
        'network', rawRequest, undefined, undefined, null
      );
    }
    // response.text() 抛异常（连接中断、响应体读取失败等）
    throw new AIError(
      `AI 响应读取失败: ${err instanceof Error ? err.message : String(err)}`,
      'read', rawRequest, undefined, undefined, null
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response) throw new AIError('AI 响应丢失', 'network', rawRequest, undefined, undefined, null); // 理论不可达，收窄类型

  if (!response.ok) {
    throw new AIError(
      `AI 请求失败 ${response.status}: ${responseText.slice(0, 500)}`,
      httpErrorType(response.status),
      rawRequest,
      responseText,
      undefined,
      response.status
    );
  }

  let data: {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  try {
    data = JSON.parse(responseText);
  } catch {
    // 响应不是 JSON——典型原因：base_url 路径配错返回了 HTML 页面
    throw new AIError(
      `AI 响应 JSON 解析失败（开头: ${responseText.slice(0, 120) || '(空)'})`,
      'bad_json', rawRequest, responseText, undefined, response.status
    );
  }

  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? '';
  const finishReason = choice?.finish_reason;

  if (!content) {
    // 推理模型的 token 预算可能全部耗在思考段（content 为空 + finish_reason=length 或 reasoning_content 非空），
    // 此时请求已到达模型并正常生成，连通性测试模式下视为成功
    const looksLikeTruncatedReasoning =
      finishReason === 'length' || !!choice?.message?.reasoning_content;
    if (!(req.allowEmptyContent && looksLikeTruncatedReasoning)) {
      throw new AIError(
        `AI 返回内容为空${finishReason ? `（finish_reason=${finishReason}）` : ''}`,
        'empty_content', rawRequest, responseText, undefined, response.status
      );
    }
  }

  // 提取 usage（部分接口可能不返回，此时为 null）
  let usage: TokenUsage | null = null;
  const u = data.usage;
  if (u && typeof u.prompt_tokens === 'number') {
    const completion = u.completion_tokens ?? 0;
    usage = {
      promptTokens: u.prompt_tokens,
      completionTokens: completion,
      totalTokens: u.total_tokens ?? (u.prompt_tokens + completion),
    };
  }

  return {
    content: content.trim(),
    model: data.model || req.model,
    usage,
    url,
    httpStatus: response.status,
    rawRequest,
    rawResponse: responseText,
  };
}
