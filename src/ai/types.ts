/** 题目类型 */
export type QuestionType = 'single' | 'multiple' | 'judgement' | 'completion' | undefined;

/** AI 渠道类型 */
export type ChannelType = 'text' | 'vision';

/** 聊天消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string };
  }>;
}

/** AI 调用参数 */
export interface AIRequest {
  messages: ChatMessage[];
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeout: number;
}

/** AI 用量统计（来自 OpenAI 兼容接口的 usage 字段） */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** AI 调用结果 */
export interface AIResult {
  content: string;
  model: string;
  /** Token 用量，接口未返回 usage 时为 null */
  usage: TokenUsage | null;
  /** 发送给 AI 的原始请求体（JSON 字符串），用于日志调试 */
  rawRequest: string;
  /** AI 返回的原始响应体（JSON 字符串），用于日志调试 */
  rawResponse: string;
}

/** 数据库行：AI 渠道 */
export interface AIChannelRow {
  id: string;
  name: string;
  type: string;
  base_url: string;
  model: string;
  weight: number;
  temperature: number;
  max_tokens: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** 数据库行：AI 渠道密钥 */
export interface AIChannelKeyRow {
  id: string;
  channel_id: string;
  api_key: string;
  name: string;
  enabled: number;
  use_count: number;
  fail_count: number;
  last_used: string | null;
  created_at: string;
}

/** 调度结果 */
export interface DispatchResult {
  content: string;
  channelName: string;
  model: string;
  /** Token 用量，接口未返回 usage 时为 null */
  usage: TokenUsage | null;
  /** 发送给 AI 的原始请求体（JSON 字符串） */
  rawRequest: string;
  /** AI 返回的原始响应体（JSON 字符串） */
  rawResponse: string;
}

/** AI 调度错误（携带原始请求/响应与失败渠道，用于调试与渠道归因） */
export class AIError extends Error {
  rawRequest?: string;
  rawResponse?: string;
  /** 全部渠道失败时，首个失败的渠道名（通常是根因渠道），用于日志归因 */
  channel?: string;
  constructor(message: string, rawRequest?: string, rawResponse?: string, channel?: string) {
    super(message);
    this.name = 'AIError';
    this.rawRequest = rawRequest;
    this.rawResponse = rawResponse;
    this.channel = channel;
  }
}
