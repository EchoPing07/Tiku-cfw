import type { AIErrorType, AttemptRecord } from './types';

/**
 * 调试信封：search_logs.ai_request / ai_response 的统一存储格式。
 * 元数据（url/channel/model/key/http_status/error_type/truncated）永不截断，
 * 判断失败原因主要靠元数据；body 超长才截断并置 truncated=true（与"响应本身格式异常"区分）。
 *
 * 旧数据无 v 字段，前端据此降级展示。
 */

/** 掩码密钥：保留前 6 位与后 4 位（信封/attempts 里绝不出现完整密钥） */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 12) return key.slice(0, 4) + '****';
  return key.slice(0, 6) + '...' + key.slice(-4);
}

/** 请求信封字段（不含 body，body 单独序列化处理） */
export interface RequestEnvelope {
  v: 1;
  url: string;
  channel: string;
  model: string;
  key: string;
  http_status: number | null;
  error_type: AIErrorType | null;
  truncated: boolean;
  body: string;
}

/** 响应信封 */
export interface ResponseEnvelope {
  v: 1;
  http_status: number | null;
  truncated: boolean;
  body: string;
}

/** 信封 body 的截断上限（字符） */
export const ENVELOPE_REQ_LIMIT = 4096;
export const ENVELOPE_RESP_LIMIT = 16384;

/** attempts 数组的整体上限与单条错误摘要上限 */
export const ATTEMPTS_LIMIT = 4096;
export const ATTEMPT_ERROR_LIMIT = 512;

/** 深度折叠消息中的 image_url（base64/长 URL 是请求体超限的元凶），记录长度即可 */
function foldImageUrls(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;
  const folded = messages.map((m) => {
    if (typeof m !== 'object' || m === null) return m;
    const msg = m as Record<string, unknown>;
    if (!Array.isArray(msg.content)) return msg;
    const content = (msg.content as Array<Record<string, unknown>>).map((part) => {
      if (typeof part !== 'object' || part === null) return part;
      const p = part as Record<string, unknown>;
      const iu = p.image_url as { url?: unknown } | undefined;
      if (iu && typeof iu.url === 'string' && iu.url.length > 0) {
        return { ...p, image_url: { url: `<<omitted: ${iu.url.length} chars>>` } };
      }
      return p;
    });
    return { ...msg, content };
  });
  return { ...body, messages: folded };
}

/** 序列化并截断（超长置 truncated 标记） */
function serializeWithTruncation(value: unknown, limit: number): { text: string; truncated: boolean } {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (s.length <= limit) return { text: s, truncated: false };
  return { text: s.slice(0, limit) + '\n...[truncated]', truncated: true };
}

/** 构造请求信封（JSON 字符串，可直接入库） */
export function buildRequestEnvelope(args: {
  url: string;
  channel: string;
  model: string;
  apiKey: string;
  httpStatus: number | null;
  errorType: AIErrorType | null;
  /** 已序列化的原始请求体（openai-client 的 rawRequest） */
  rawRequestBody: string;
  limit?: number;
}): string {
  let bodyObj: unknown;
  try {
    bodyObj = JSON.parse(args.rawRequestBody);
  } catch {
    bodyObj = args.rawRequestBody; // 理论不可达，兜底存原文
  }
  const folded = typeof bodyObj === 'object' && bodyObj !== null
    ? foldImageUrls(bodyObj as Record<string, unknown>)
    : bodyObj;
  const { text, truncated } = serializeWithTruncation(folded, args.limit ?? ENVELOPE_REQ_LIMIT);
  const envelope: RequestEnvelope = {
    v: 1,
    url: args.url,
    channel: args.channel,
    model: args.model,
    key: maskKey(args.apiKey),
    http_status: args.httpStatus,
    error_type: args.errorType,
    truncated,
    body: text,
  };
  return JSON.stringify(envelope);
}

/** 构造响应信封（JSON 字符串，可直接入库） */
export function buildResponseEnvelope(args: {
  httpStatus: number | null;
  rawBody: string;
  limit?: number;
}): string {
  const { text, truncated } = serializeWithTruncation(args.rawBody, args.limit ?? ENVELOPE_RESP_LIMIT);
  const envelope: ResponseEnvelope = {
    v: 1,
    http_status: args.httpStatus,
    truncated,
    body: text,
  };
  return JSON.stringify(envelope);
}

/** 追加一条尝试记录，整体超限时丢弃最早的 error 详情保长度（保序、保条数） */
export function appendAttempt(attempts: AttemptRecord[], rec: AttemptRecord): AttemptRecord[] {
  const next = [...attempts, { ...rec, error: rec.error ? rec.error.slice(0, ATTEMPT_ERROR_LIMIT) : null }];
  let s = JSON.stringify(next);
  if (s.length <= ATTEMPTS_LIMIT) return next;
  // 超限：从最早的条目开始丢 error 详情（保留计数与状态）
  const trimmed = next.map((a, i) => (i < next.length - 3 && a.error ? { ...a, error: a.error.slice(0, 80) } : a));
  s = JSON.stringify(trimmed);
  return s.length <= ATTEMPTS_LIMIT ? trimmed : trimmed.slice(0, Math.max(2, trimmed.length - 4));
}
