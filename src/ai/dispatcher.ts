import type { Env } from '../types/env';
import type { ChatMessage, DispatchResult, AIChannelRow, AttemptRecord, AIErrorType } from './types';
import { AIError } from './types';
import { callOpenAI } from './openai-client';
import { buildSystemPrompt, buildUserMessage, buildVisionMessage } from './prompt';
import { parseAIAnswer } from './answer-parser';
import { parseExtraParams } from './extra-params';
import { buildThinkingParams } from './thinking';
import { appendAttempt, buildRequestEnvelope, buildResponseEnvelope, maskKey } from './debug-envelope';
import { fetchImagesAsDataUrls } from './image-fetch';
import { extractImageMatches, parseImagePatterns } from '../utils/question-images';
import { classifyUrlQuestionMode, buildUrlOptionMapForMode, resolveUrlAnswer, type UrlQuestionMode } from './url-question';
import type { QuestionType } from './types';

interface DispatchOptions {
  title: string;
  type?: QuestionType;
  options?: string;
  images?: string[];
  /** 图片性 URL 模式（settings.image_url_patterns；缺省用默认 /ananas/） */
  imagePatterns?: RegExp[];
  env: Env;
}

/**
 * 加权随机生成尝试顺序（不放回抽签）：
 * 权重 3:1 的两个条目，健康时流量约 75%/25%；某条目失败后从剩余条目中
 * 重新加权抽取，所有条目都可能在一次请求内被依次尝试（不重试同一条目）。
 * 复制条目 = 同模型多 Key 分摊：权重相同即均匀分流。
 */
export function weightedRandomOrder<T extends { weight: number }>(items: T[]): T[] {
  const pool = [...items];
  const order: T[] = [];
  while (pool.length > 0) {
    const total = pool.reduce((s, c) => s + c.weight, 0);
    let r = Math.random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].weight;
      if (r < 0) { idx = i; break; }
    }
    order.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return order;
}

/** 调度总预算：多模型全挂时避免 N×超时 的串行等待拖垮请求；图题含图片推理更慢，预算放宽 */
const MAX_DISPATCH_MS = 60_000;
const MAX_DISPATCH_VISION_MS = 90_000;

/**
 * 瞬时类错误：同条目预算内重试一次（429 限流一瞬即逝、网络抖动/响应中断多为一过性）。
 * 非瞬时错误（鉴权失败/参数错误/JSON 异常等）重试没有意义，立即换下一条目。
 * （http_server 5xx 也可能是瞬时，但按既定方案从严处理，避免把预算烧在故障上游上）
 */
const TRANSIENT_ERROR_TYPES: ReadonlySet<AIErrorType> = new Set(['http_rate', 'timeout', 'network', 'read']);

/** 同条目重试退避：min(2000, 400×attempt) ms */
const retryBackoffMs = (attempt: number): number => Math.min(2000, 400 * attempt);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 多模型 AI 调度器（模型条目化：一个条目 = 端点 + 模型 + 单 Key + 权重） */
export async function dispatchAI(opts: DispatchOptions): Promise<DispatchResult> {
  const { title, type, options, images, env } = opts;

  // 带图题走视觉链路；纯文本题默认全量条目参与（视觉条目也能答文本题），
  // 可用设置 text_exclude_vision 让视觉条目只答图题
  const isVision = !!(images && images.length > 0);

  // 读取设置（一次性查询，减少 D1 往返）
  let timeout = 30;
  let visionTimeout = 60;
  let failThreshold = 3;
  let cooldownMinutes = 10;
  let customPrompt = '';
  let textExcludeVision = false;
  try {
    const settingsRes = await env.DB.prepare(
      `SELECT key, value FROM settings WHERE key IN ('ai_timeout', 'vision_timeout', 'key_fail_threshold', 'channel_cooldown_minutes', 'system_prompt', 'text_exclude_vision')`
    ).all<{ key: string; value: string }>();
    for (const r of settingsRes.results || []) {
      if (r.key === 'ai_timeout') timeout = parseInt(r.value, 10) || timeout;
      else if (r.key === 'vision_timeout') visionTimeout = parseInt(r.value, 10) || visionTimeout;
      else if (r.key === 'key_fail_threshold') failThreshold = parseInt(r.value, 10) || failThreshold;
      else if (r.key === 'channel_cooldown_minutes') cooldownMinutes = parseInt(r.value, 10) || 0;
      else if (r.key === 'system_prompt') customPrompt = r.value;
      else if (r.key === 'text_exclude_vision') textExcludeVision = r.value === '1';
    }
  } catch { /* 用默认值 */ }
  const systemPrompt = buildSystemPrompt(customPrompt);

  // 带图题单次超时独立配置（图题含图片下载与视觉推理，天然更慢）；
  // 调度总预算随题目类型放宽，否则 vision 的长超时一次尝试就吃光预算，失败转移形同虚设
  const perAttemptTimeout = isVision ? visionTimeout : timeout;
  const budgetMs = isVision ? MAX_DISPATCH_VISION_MS : MAX_DISPATCH_MS;
  const deadline = Date.now() + budgetMs;

  // 带图题仅调度支持视觉的条目（绕过纯文本模型）；纯文本题默认全量条目参与，
  // 开启 text_exclude_vision 后仅纯文本条目（视觉条目只答图题）。
  // 提前到消息构建之前：无可用条目直接失败，不浪费图片抓取
  const typeFilter = isVision ? "type = 'vision'" : textExcludeVision ? "type = 'text'" : '';
  const typeWhere = typeFilter ? `${typeFilter} AND ` : '';
  const channels = await env.DB.prepare(
    `SELECT * FROM ai_channels
     WHERE ${typeWhere}enabled = 1
       AND api_key IS NOT NULL AND api_key != ''
       AND (disabled_until IS NULL OR disabled_until <= datetime('now'))
     ORDER BY weight DESC`
  ).all<AIChannelRow>();

  const candidates = channels.results || [];

  if (candidates.length === 0) {
    // 区分“没配模型”和“全在冷却中”，给出可操作的报错
    let cooling = 0;
    try {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ai_channels
         WHERE ${typeWhere}enabled = 1
           AND api_key IS NOT NULL AND api_key != ''
           AND disabled_until > datetime('now')`
      ).first<{ n: number }>();
      cooling = row?.n || 0;
    } catch { /* 忽略 */ }
    throw new AIError(
      cooling > 0
        ? `没有可用的${isVision ? '视觉' : '文本'}模型（${cooling} 个条目熔断冷却中，稍后自动恢复）`
        : `没有可用的${isVision ? '视觉' : '文本'}模型（请检查是否已添加并启用、是否填写了 API Key）`,
      'no_channel'
    );
  }

  // 构建消息；图题同时准备 ANSWER 协议的答案解析器（编号/字母 → 选项正文）
  let messages: ChatMessage[];
  let answerMode: UrlQuestionMode | null = null;
  let answerOptionMap: Map<string, string> | null = null;

  if (isVision && images && images.length > 0) {
    // 1. 提取 title/options 内嵌图片（带位置信息，供图文交错与抓取）
    const patterns = opts.imagePatterns ?? parseImagePatterns(null);
    const titleMatches = extractImageMatches(title, { patterns });
    const optionsMatches = options ? extractImageMatches(options, { patterns }) : [];
    const textUrls = new Set([...titleMatches, ...optionsMatches].map((m) => m.url));

    // 2. images 参数中不在题目文本里的额外图（无位置信息，消息末尾追加）
    const extraImages = images.filter((u) => u && !textUrls.has(u));

    // 3. Worker 侧伪装下载（UA/Referer 伪装 → 魔数嗅探 → base64 内联）；单图失败回退原始
    //    URL（厂商代抓兜底）；下载耗时计入调度总预算
    const fetchEntries: Array<{ key: string; url: string }> = [];
    const seen = new Set<string>();
    for (const m of [...titleMatches, ...optionsMatches]) {
      if (m.isImage && !seen.has(m.url)) {
        seen.add(m.url);
        fetchEntries.push({ key: m.url, url: m.fetchUrl });
      }
    }
    for (const u of extraImages) {
      if (u && !seen.has(u)) {
        seen.add(u);
        fetchEntries.push({ key: u, url: u });
      }
    }
    let dataUrls = new Map<string, string>();
    if (fetchEntries.length > 0) {
      try {
        dataUrls = await fetchImagesAsDataUrls(fetchEntries);
      } catch {
        // 全部回退原始 URL，不阻塞搜题
      }
    }
    const resolvedImages = new Map<string, string>();
    for (const e of fetchEntries) {
      resolvedImages.set(e.key, dataUrls.get(e.key) ?? e.url);
    }

    // 4. 图文交错消息（图片按原文位置插入）+ ANSWER 协议
    messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildVisionMessage(title, options, resolvedImages, extraImages, type, patterns) },
    ];

    answerMode = classifyUrlQuestionMode(type, options);
    answerOptionMap = buildUrlOptionMapForMode(answerMode, options);
  } else {
    messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserMessage(title, type, options) },
    ];
  }

  // 加权随机生成尝试顺序（失败不放回）；瞬时类错误在同条目上退避重试一次（见循环内）
  const ordered = weightedRandomOrder(candidates);

  // 尝试链（成功 + 失败全记录，写入日志 attempts 列）
  let attempts: AttemptRecord[] = [];
  // 最终报错携带：首次失败的信封（根因优先）
  let firstError = '';
  let firstErrorType: AIErrorType | null = null;
  let firstHttpStatus: number | null = null;
  let firstChannel = '';
  let firstRequestEnvelope = '';
  let firstResponseEnvelope = '';

  for (const channel of ordered) {
    // 超出总预算：中止剩余尝试（未尝试的条目不计入失败），携带已有错误直接抛出
    if (Date.now() >= deadline) {
      throw new AIError(
        `AI 调度总耗时超过 ${Math.round(budgetMs / 1000)}s，已中止剩余尝试` +
          (firstError ? `（首次错误：${firstError}）` : ''),
        'budget',
        firstRequestEnvelope || undefined,
        firstResponseEnvelope || undefined,
        firstChannel || undefined,
        firstHttpStatus,
        attempts
      );
    }

    // 条目级参数：思考等级按模型 ID 自动映射的厂商参数在前，手工 extra_params 在后
    // （同键以手工配置为准）；存量非法 extra_params 降级为不附加，不阻塞搜题
    const thinkingParams = buildThinkingParams(channel.model as string, channel.thinking_level);
    const manualParams = parseExtraParams(channel.extra_params as string | null);
    const extraParams = thinkingParams || manualParams ? { ...thinkingParams, ...manualParams } : undefined;

    // 单次尝试超时不超过剩余预算（预算是硬顶：临近预算末尾的尝试快速失败，
    // 而不是越过预算后再拖满整个超时——否则 vision 最坏可挂 90+60=150s）
    const attemptTimeout = Math.max(1, Math.min(perAttemptTimeout, Math.ceil((deadline - Date.now()) / 1000)));

    // 同条目最多尝试 2 次：首次失败且为瞬时类错误（429/超时/网络）时退避后重试一次；
    // 重试仍失败或非瞬时错误则计入熔断并换下一条目。只配一个条目的部署
    // （自用场景极常见）不再“瞬时抖动 = 直接失败”
    for (let attempt = 1; ; attempt++) {
      const startedAt = Date.now();
      try {
        const result = await callOpenAI({
          messages,
          baseUrl: channel.base_url as string,
          apiKey: channel.api_key as string,
          model: channel.model as string,
          temperature: channel.temperature as number,
          maxTokens: channel.max_tokens as number,
          timeout: attemptTimeout,
          extraParams,
        });

        // 成功：清零失败计数、记录使用（含解除冷却），并入调用方 batch 之外的独立轻量更新
        await env.DB.prepare(
          `UPDATE ai_channels
           SET use_count = use_count + 1, fail_count = 0, last_used = datetime('now'), disabled_until = NULL
           WHERE id = ?`
        ).bind(channel.id).run();

        attempts = appendAttempt(attempts, {
          seq: attempts.length + 1,
          channel: channel.name as string,
          model: result.model,
          key: maskKey(channel.api_key as string),
          ok: true,
          http_status: result.httpStatus,
          error_type: null,
          error: null,
          latency_ms: Date.now() - startedAt,
        });

        // 解析答案：图题优先 ANSWER 协议（编号/字母 → 选项正文）；无 ANSWER 行（模型未遵循
        // 协议）回退通用解析
        const parsedAnswer =
          answerMode !== null
            ? resolveUrlAnswer(result.content, answerOptionMap ?? new Map(), answerMode) ||
              parseAIAnswer(result.content, type)
            : parseAIAnswer(result.content, type);

        return {
          content: parsedAnswer,
          channelName: channel.name as string,
          model: result.model,
          usage: result.usage,
          url: result.url,
          httpStatus: result.httpStatus,
          attempts,
          rawRequest: buildRequestEnvelope({
            url: result.url,
            channel: channel.name as string,
            model: result.model,
            apiKey: channel.api_key as string,
            httpStatus: result.httpStatus,
            errorType: null,
            rawRequestBody: result.rawRequest,
          }),
          rawResponse: buildResponseEnvelope({
            httpStatus: result.httpStatus,
            rawBody: result.rawResponse,
          }),
        };
      } catch (err) {
        const isAIErr = err instanceof AIError;
        const errMsg = err instanceof Error ? err.message : String(err);
        const errType = isAIErr ? err.errorType : 'network' as AIErrorType;
        const httpStatus = isAIErr ? err.httpStatus : null;
        const rawReq = isAIErr ? (err.rawRequest || '') : '';
        const rawResp = isAIErr ? (err.rawResponse || '') : '';

        attempts = appendAttempt(attempts, {
          seq: attempts.length + 1,
          channel: channel.name as string,
          model: channel.model as string,
          key: maskKey(channel.api_key as string),
          ok: false,
          http_status: httpStatus,
          error_type: errType,
          error: errMsg,
          latency_ms: Date.now() - startedAt,
        });

        // 首次失败通常是根因（如 401 无效 key），优先保留其信封；
        // 重试导致的第二次失败不覆盖根因记录
        if (!firstError) {
          firstError = errMsg;
          firstErrorType = errType;
          firstHttpStatus = httpStatus;
          firstChannel = channel.name as string;
          firstRequestEnvelope = buildRequestEnvelope({
            url: (channel.base_url as string).replace(/\/$/, '') + '/chat/completions',
            channel: channel.name as string,
            model: channel.model as string,
            apiKey: channel.api_key as string,
            httpStatus,
            errorType: errType,
            rawRequestBody: rawReq,
          });
          firstResponseEnvelope = buildResponseEnvelope({ httpStatus, rawBody: rawResp });
        }

        // 瞬时类错误且预算还够退避：同条目重试一次（重试成功不计失败、不触发熔断）
        if (attempt === 1 && TRANSIENT_ERROR_TYPES.has(errType) && Date.now() + retryBackoffMs(attempt) < deadline) {
          await sleep(retryBackoffMs(attempt));
          continue;
        }

        // 条目最终失败：原子自增 fail_count，达阈值进入熔断冷却并归零计数（单条 UPDATE 避免读改写竞态）
        await env.DB.prepare(
          `UPDATE ai_channels
           SET fail_count = CASE WHEN fail_count + 1 >= ? THEN 0 ELSE fail_count + 1 END,
               disabled_until = CASE
                 WHEN fail_count + 1 >= ? THEN datetime('now', '+' || ? || ' minutes')
                 ELSE disabled_until
               END
           WHERE id = ?`
        ).bind(failThreshold, failThreshold, cooldownMinutes, channel.id).run();

        break; // 换下一个条目
      }
    }
  }

  // 所有条目都失败，携带错误详情（根因 + 尝试链）便于排查
  throw new AIError(
    `所有模型均不可用（${firstError}）`,
    firstErrorType ?? 'network',
    firstRequestEnvelope || undefined,
    firstResponseEnvelope || undefined,
    firstChannel || undefined,
    firstHttpStatus,
    attempts
  );
}
