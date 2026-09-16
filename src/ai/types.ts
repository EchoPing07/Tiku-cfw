/** 题目类型 */
export type QuestionType = 'single' | 'multiple' | 'judgement' | 'completion' | undefined;

/** AI 模型类型（text 文本 / vision 视觉） */
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

/**
 * 错误分类（排障判据）：
 * - timeout            请求超时（AbortError）
 * - network            fetch 本身失败（DNS/域名错误/出网被墙）——多为 base_url 配错
 * - read               响应体读取失败（连接中断）
 * - http_auth          401/403 —— Key 无效或被封禁
 * - http_rate          429 —— 上游限流
 * - http_bad_request   400 —— 模型名/参数格式问题
 * - http_server        5xx —— 上游服务故障
 * - http_other         其余非 2xx
 * - bad_json           响应不是合法 JSON——多为 base_url 路径配错返回了 HTML 页面
 * - empty_content      content 为空（推理模型思考占满 max_tokens 等）
 * - no_channel         该类型下没有可用模型条目
 * - no_key             条目未配置 API Key
 * - budget             调度总预算耗尽
 * - bad_input          入站搜题请求格式/校验错误（非 AI 错误）
 */
export type AIErrorType =
  | 'timeout'
  | 'network'
  | 'read'
  | 'http_auth'
  | 'http_rate'
  | 'http_bad_request'
  | 'http_server'
  | 'http_other'
  | 'bad_json'
  | 'empty_content'
  | 'no_channel'
  | 'no_key'
  | 'budget'
  | 'bad_input';

/** AI 调用参数 */
export interface AIRequest {
  messages: ChatMessage[];
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeout: number;
  /** 连通性测试模式：content 为空但响应合法（length 截断 / 仅有思考内容）时不视为错误 */
  allowEmptyContent?: boolean;
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
  /** 实际请求的完整 URL（含 /chat/completions），排障用 */
  url: string;
  /** 上游 HTTP 状态码 */
  httpStatus: number;
  /** 发送给 AI 的原始请求体（JSON 字符串），用于日志调试 */
  rawRequest: string;
  /** AI 返回的原始响应体（JSON 字符串），用于日志调试 */
  rawResponse: string;
}

/** 数据库行：AI 模型条目（表 ai_channels，一个条目自带一个 API Key） */
export interface AIChannelRow {
  id: string;
  name: string;
  type: string;
  base_url: string;
  model: string;
  api_key: string | null;
  weight: number;
  temperature: number;
  max_tokens: number;
  enabled: number;
  use_count: number;
  fail_count: number;
  last_used: string | null;
  disabled_until: string | null;
  created_at: string;
  updated_at: string;
}

/** 调度单次尝试记录（写入 search_logs.attempts，逐条展示调度链路） */
export interface AttemptRecord {
  seq: number;
  /** 条目（模型）名 */
  channel: string;
  model: string;
  /** 掩码后的 API Key（如 sk-***abc4） */
  key: string;
  ok: boolean;
  http_status: number | null;
  error_type: AIErrorType | null;
  /** 错误摘要（≤512 字符） */
  error: string | null;
  latency_ms: number;
}

/** 调度结果 */
export interface DispatchResult {
  content: string;
  channelName: string;
  model: string;
  /** Token 用量，接口未返回 usage 时为 null */
  usage: TokenUsage | null;
  /** 成功那次请求的完整 URL */
  url: string;
  /** 成功那次的 HTTP 状态码 */
  httpStatus: number;
  /** 全部尝试链（成功 + 失败，按时间序） */
  attempts: AttemptRecord[];
  /** 发送给 AI 的原始请求体（JSON 字符串） */
  rawRequest: string;
  /** AI 返回的原始响应体（JSON 字符串） */
  rawResponse: string;
}

/** AI 调用/调度错误（携带错误分类与原始报文，用于调试与模型归因） */
export class AIError extends Error {
  /** 错误分类 */
  errorType: AIErrorType;
  /** 上游 HTTP 状态码（网络错误为 null） */
  httpStatus: number | null;
  /** 发送的原始请求体 */
  rawRequest?: string;
  /** 上游返回的原始响应体 */
  rawResponse?: string;
  /** 失败的模型条目名（用于日志归因） */
  channel?: string;
  /** 调度尝试链（全挂/预算耗尽时携带，成功路径不适用） */
  attempts?: AttemptRecord[];
  constructor(
    message: string,
    errorType: AIErrorType = 'network',
    rawRequest?: string,
    rawResponse?: string,
    channel?: string,
    httpStatus: number | null = null,
    attempts?: AttemptRecord[]
  ) {
    super(message);
    this.name = 'AIError';
    this.errorType = errorType;
    this.httpStatus = httpStatus;
    this.rawRequest = rawRequest;
    this.rawResponse = rawResponse;
    this.channel = channel;
    this.attempts = attempts;
  }
}
