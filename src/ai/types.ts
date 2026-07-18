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

/** AI 调用结果 */
export interface AIResult {
  content: string;
  model: string;
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
}
