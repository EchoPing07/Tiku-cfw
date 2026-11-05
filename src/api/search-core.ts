import type { Env } from '../types/env';
import { normalizeAndHash, normalizeOptions, questionHash } from '../cache/normalize';
import { dispatchAI } from '../ai/dispatcher';
import { isRefusalAnswer } from '../ai/answer-parser';
import { AIError, type TokenUsage, type AIErrorType, type AttemptRecord, type QuestionType } from '../ai/types';
import { normalizeQuestionType } from '../ai/question-type';
import { parseImagePatterns } from '../utils/question-images';
import { uuid } from '../utils/id';

/** 搜题输入 */
export interface SearchInput {
  title: string;
  /** 归一化后的题型（single/multiple/judgement/completion/undefined） */
  type?: QuestionType;
  options?: string;
  images?: string[];
  /**
   * OCS 图片题优化 v2：`suggestion_title` / `suggestion_options` 是原题把图片 URL 换成
   * `[图片N]` 占位符后的文本（与之严格同序的 base64 图在 images 数组里）。
   * 存在时优先作为题干/选项传给模型，图片按占位符位置内联。
   */
  suggestionTitle?: string;
  suggestionOptions?: string;
  /** data URL 形态图片（v2 的 base64），与 suggestionTitle 中的 [图片N] 严格同序 */
  inlineImages?: string[];
}

/** 搜题结果（供 OCS 接口与调试控制台共用） */
export interface SearchCoreResult {
  found: boolean;
  fromCache: boolean;
  /** 命中的题目文本（缓存命中为缓存题目，AI 生成为原始题目） */
  question: string;
  answer: string | null;
  channel: string | null;
  model: string | null;
  durationMs: number;
  usage: TokenUsage | null;
  error: string | null;
  /** 错误分类（AI 调用失败时；bad_input=入站请求本身无效） */
  errorType: AIErrorType | null;
  httpStatus: number | null;
  rawRequest: string | null;
  rawResponse: string | null;
  /** 调度尝试链（AI 生成时） */
  attempts: AttemptRecord[] | null;
  /** 输入本身无效（如归一化后为空），调用方应对外返回 400 而非"未找到" */
  invalidInput?: boolean;
}

/** 输入上限：防畸形/超大请求撑爆 AI 提示词与日志行 */
const MAX_TITLE_LEN = 8192;
const MAX_OPTIONS_LEN = 16384;
const MAX_IMAGES = 10;
/** http(s) 图片地址上限 */
const MAX_IMAGE_URL_LEN = 8192;
/**
 * base64 data URL 单张上限（字符数）。OCS 图片题优化 v2 传的是 base64 图
 * （`data:image/png;base64,...`），按 URL 的 8192 字符限制会直接 400；
 * 单张 8 MiB 字符 ≈ 6 MiB 原图，覆盖手机截图/公式图绰绰有余。
 */
const MAX_IMAGE_DATA_URL_LEN = 8 * 1024 * 1024;
/** 全部图片字符总量上限（Worker 内存 128 MiB，留出解析与提示词余量） */
const MAX_IMAGES_TOTAL_LEN = 24 * 1024 * 1024;

/** 是否为 base64 data URL 图片（OCS v2 图片题优化形态） */
const DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;

export const isDataUrlImage = (s: string): boolean => DATA_URL_RE.test(s);

/** 图片身份键（base64 内容哈希）：data URL 无法进 URL 集合，改用内容哈希参与缓存键 */
async function inlineImageIdentity(dataUrl: string): Promise<string> {
  const bytes = new TextEncoder().encode(dataUrl);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .slice(0, 32)
    .join('');
  return `inline:${hex}`;
}

/**
 * 校验搜题请求体（类型 + 长度），兼容 OCS 客户端（老版 `title/type/options` 与 5.x 图片题
 * 优化 v2 的 `images/suggestion_title/suggestion_options`）与调试台。
 * images 过滤空项与 null，全部过滤后视为无图（走文本模型）。
 */
export function parseSearchInput(body: unknown): { ok: true; input: SearchInput } | { ok: false; msg: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, msg: '请求体格式错误' };
  const b = body as Record<string, unknown>;

  if (typeof b.title !== 'string' || !b.title.trim()) return { ok: false, msg: '题目(title)不能为空' };
  if (b.title.length > MAX_TITLE_LEN) return { ok: false, msg: `题目过长（≤${MAX_TITLE_LEN} 字符）` };

  if (b.type !== undefined && b.type !== null && typeof b.type !== 'string') {
    return { ok: false, msg: '题型(type)必须为字符串' };
  }

  // options：OCS 官方文档的自定义字段解析器示例会返回数组（handler: env.options.split('\n')），
  // 数组按行拼接而不是直接 400，否则照抄官方示例的配置全部搜题失败
  let optionsText: string | undefined;
  if (b.options !== undefined && b.options !== null) {
    if (typeof b.options === 'string') {
      optionsText = b.options;
    } else if (Array.isArray(b.options) && b.options.every((o) => o === null || o === undefined || typeof o === 'string')) {
      optionsText = b.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').join('\n');
    } else {
      return { ok: false, msg: '选项(options)必须为字符串或字符串数组' };
    }
    if (optionsText.length > MAX_OPTIONS_LEN) return { ok: false, msg: `选项内容过长（≤${MAX_OPTIONS_LEN} 字符）` };
  }

  // 图片题优化 v2 的文本字段（可选，纯字符串）
  for (const [key, label] of [['suggestion_title', '题干图片占位文本(suggestion_title)'], ['suggestion_options', '选项图片占位文本(suggestion_options)']] as const) {
    const v = b[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return { ok: false, msg: `${label}必须为字符串` };
    if (v.length > MAX_OPTIONS_LEN) return { ok: false, msg: `${label}过长` };
  }

  let images: string[] | undefined;
  if (b.images !== undefined && b.images !== null) {
    if (!Array.isArray(b.images)) return { ok: false, msg: '图片(images)必须是字符串数组' };
    const imgs: string[] = [];
    let totalLen = 0;
    for (const it of b.images) {
      if (it === null || it === undefined) continue;
      if (typeof it !== 'string') return { ok: false, msg: '图片列表包含非字符串项' };
      const u = it.trim();
      if (!u) continue;
      if (isDataUrlImage(u)) {
        if (u.length > MAX_IMAGE_DATA_URL_LEN) {
          return { ok: false, msg: `单张图片过大（≤${Math.floor(MAX_IMAGE_DATA_URL_LEN / 1024 / 1024)} MiB base64）` };
        }
      } else if (u.length > MAX_IMAGE_URL_LEN) {
        return { ok: false, msg: '图片 URL 过长' };
      }
      totalLen += u.length;
      if (totalLen > MAX_IMAGES_TOTAL_LEN) {
        return { ok: false, msg: `图片总量过大（≤${Math.floor(MAX_IMAGES_TOTAL_LEN / 1024 / 1024)} MiB）` };
      }
      imgs.push(u);
    }
    if (imgs.length > MAX_IMAGES) return { ok: false, msg: `图片数量过多（≤${MAX_IMAGES} 张）` };
    images = imgs.length > 0 ? imgs : undefined;
  }

  return {
    ok: true,
    input: {
      title: b.title,
      // OCS 5.x 未指定题型时传字面量 'unknown'：折叠成 undefined，避免污染提示词/答案解析/题库 type
      type: normalizeQuestionType(typeof b.type === 'string' ? b.type : undefined),
      options: optionsText && optionsText ? optionsText : undefined,
      images,
      suggestionTitle: typeof b.suggestion_title === 'string' && b.suggestion_title.trim() ? b.suggestion_title : undefined,
      suggestionOptions: typeof b.suggestion_options === 'string' && b.suggestion_options.trim() ? b.suggestion_options : undefined,
    },
  };
}

/** 截断字符串到指定长度，超长则追加截断标记 */
export function truncate(s: string | null | undefined, maxLen: number): string | null {
  if (!s) return null;
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '\n...[truncated]';
}

interface LogRow {
  question: string;
  hash: string;
  found: boolean;
  fromCache: boolean;
  answer?: string | null;
  channel?: string | null;
  model?: string | null;
  durationMs: number;
  apiKeyId?: string | null;
  error?: string | null;
  errorType?: AIErrorType | null;
  httpStatus?: number | null;
  rawRequest?: string | null;
  rawResponse?: string | null;
  usage?: TokenUsage | null;
  attempts?: AttemptRecord[] | null;
}

/**
 * 写搜索日志：按迁移状态逐级降级构造语句。
 * trace(0007，含 http_status/error_type/attempts) → full(0003+0005) → debug(0003) → base(0001)。
 * 列级别按 isolate 探测一次并缓存，避免每次写入都先经历失败查询。
 */
type LogsSchema = 'trace' | 'full' | 'debug' | 'base';
let logsSchema: LogsSchema | null = null;

const isNoSuchColumn = (err: unknown): boolean => err instanceof Error && /no such column/i.test(err.message);

async function detectLogsSchema(env: Env): Promise<LogsSchema> {
  if (logsSchema) return logsSchema;
  try {
    await env.DB.prepare('SELECT ai_request, ai_response FROM search_logs LIMIT 1').first();
  } catch (err) {
    if (!isNoSuchColumn(err)) throw err;
    return (logsSchema = 'base');
  }
  try {
    await env.DB.prepare('SELECT prompt_tokens, completion_tokens, total_tokens FROM search_logs LIMIT 1').first();
  } catch (err) {
    if (!isNoSuchColumn(err)) throw err;
    return (logsSchema = 'debug');
  }
  try {
    await env.DB.prepare('SELECT error_type, http_status, attempts FROM search_logs LIMIT 1').first();
  } catch (err) {
    if (!isNoSuchColumn(err)) throw err;
    return (logsSchema = 'full');
  }
  return (logsSchema = 'trace');
}

/** attempts 列上限（与 debug-envelope 的 ATTEMPTS_LIMIT 一致） */
const LOG_ATTEMPTS_LIMIT = 4096;

/** 构造日志 INSERT 语句（并入 batch 一次往返写入）；schema 探测失败时返回 null（放弃本条日志） */
async function buildLogStmt(env: Env, r: LogRow): Promise<D1PreparedStatement | null> {
  let schema: LogsSchema;
  try {
    schema = await detectLogsSchema(env);
  } catch {
    return null;
  }
  const id = uuid();
  const base = [
    r.question, r.hash, r.found ? 1 : 0, r.fromCache ? 1 : 0,
    r.answer ?? null, r.channel ?? null, r.model ?? null,
    r.durationMs, r.apiKeyId ?? null, r.error ?? null,
  ];
  if (schema === 'trace') {
    const attemptsJson = r.attempts ? truncate(JSON.stringify(r.attempts), LOG_ATTEMPTS_LIMIT) : null;
    return env.DB.prepare(
      `INSERT INTO search_logs (id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, api_key_id, error, ai_request, ai_response, prompt_tokens, completion_tokens, total_tokens, http_status, error_type, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, ...base, truncate(r.rawRequest, 8192), truncate(r.rawResponse, 16384),
      r.usage?.promptTokens ?? 0, r.usage?.completionTokens ?? 0, r.usage?.totalTokens ?? 0,
      r.httpStatus ?? null, r.errorType ?? null, attemptsJson
    );
  }
  if (schema === 'full') {
    return env.DB.prepare(
      `INSERT INTO search_logs (id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, api_key_id, error, ai_request, ai_response, prompt_tokens, completion_tokens, total_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, ...base, truncate(r.rawRequest, 4096), truncate(r.rawResponse, 4096),
      r.usage?.promptTokens ?? 0, r.usage?.completionTokens ?? 0, r.usage?.totalTokens ?? 0
    );
  }
  if (schema === 'debug') {
    return env.DB.prepare(
      `INSERT INTO search_logs (id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, api_key_id, error, ai_request, ai_response)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, ...base, truncate(r.rawRequest, 4096), truncate(r.rawResponse, 4096));
  }
  return env.DB.prepare(
    `INSERT INTO search_logs (id, question, question_hash, found, from_cache, answer, ai_channel, ai_model, duration_ms, api_key_id, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, ...base);
}

/** 合并执行写库语句（单次 D1 往返）；失败仅记 console，不影响搜题结果返回 */
async function safeBatch(env: Env, stmts: Array<D1PreparedStatement | null>): Promise<void> {
  const list = stmts.filter((s): s is D1PreparedStatement => s !== null);
  if (list.length === 0) return;
  try {
    await env.DB.batch(list);
  } catch (err) {
    console.error('post-search DB writes failed:', err);
  }
}

/** 写入“入站请求无效”日志（bad_input：body 非 JSON / 校验失败），question 存截断摘要 */
export async function logBadInput(env: Env, rawBody: string, hash: string, msg: string): Promise<void> {
  await safeBatch(env, [
    await buildLogStmt(env, {
      question: truncate(rawBody, 200) || '(空)',
      hash,
      found: false, fromCache: false,
      durationMs: 0, apiKeyId: null,
      error: msg, errorType: 'bad_input',
    }),
  ]);
}

/** 读取图片性 URL 模式（settings.image_url_patterns 可热更；读取失败/未配置回退默认 /ananas/） */
async function getImagePatterns(env: Env): Promise<RegExp[]> {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'image_url_patterns'"
    ).first<{ value: string }>();
    return parseImagePatterns(row?.value);
  } catch {
    return parseImagePatterns(null);
  }
}

/**
 * 从 OCS v2 的 base64 图数组中拆出：可直接交给视觉模型的 data URL，
 * 以及用于缓存键的身份键（内容哈希，避免 base64 原文塞进 key）。
 */
export async function describeImages(images: string[] | undefined): Promise<{
  inlineImages: string[];
  identities: string[];
  remoteUrls: string[];
}> {
  const inlineImages: string[] = [];
  const identities: string[] = [];
  const remoteUrls: string[] = [];
  for (const raw of images || []) {
    const u = raw.trim();
    if (!u) continue;
    if (isDataUrlImage(u)) {
      inlineImages.push(u);
      identities.push(await inlineImageIdentity(u));
    } else {
      remoteUrls.push(u);
    }
  }
  return { inlineImages, identities, remoteUrls };
}

/**
 * 搜题核心流程：归一化 → 查缓存 → 未命中调 AI → 写缓存/日志。
 * apiKeyId 为 null 时（管理面板在线搜题）不更新题库密钥使用统计。
 */
export async function performSearch(env: Env, input: SearchInput, apiKeyId: string | null): Promise<SearchCoreResult> {
  const title = input.title.trim();
  const startTime = Date.now();

  // 图片性 URL 模式（超星等无后缀图床）：决定 title/options 内嵌 URL 是否路由到视觉模型
  const imagePatterns = await getImagePatterns(env);

  // OCS 图片题优化 v2：图片以 base64 直接上传，题干里是 [图片N] 占位符。
  // 拆出 data URL（直接给视觉模型，无需 Worker 再抓）与内容哈希（缓存身份）。
  const described = await describeImages(input.images);

  // 归一化：URL 摘出占位 + URL 集合 + base64 图内容哈希入键
  // （同图不同 base64 形态同键、异图异键）；imageUrls = title/options 内嵌的图片性 URL
  // （OCS 图题常态：图 URL 内嵌在 title 里，而非 images 数组）
  const { normalized, hash, optionsNorm, imageUrls, hasUrls } = await normalizeAndHash(title, input.options, {
    imagePatterns,
    extraIdentities: described.identities,
  });

  // 内嵌图片 URL + 显式 http(s) images 合并去重（客户端数组优先，上限沿用 MAX_IMAGES）；
  // base64 图单独走 inlineImages，不参与 URL 抓取
  const images = [...new Set([...described.remoteUrls, ...imageUrls])].slice(0, MAX_IMAGES);
  const inlineImages = described.inlineImages.slice(0, MAX_IMAGES);
  const hasImages = images.length > 0 || inlineImages.length > 0;

  // 归一化后为空（题目只含标点/格式标记等）：不查缓存也不调 AI，
  // 避免所有"空"题目命中同一条 SHA-256("") 缓存互相串答案
  if (!normalized) {
    const durationMs = Date.now() - startTime;
    const msg = '题目内容无效（去除格式标记后为空）';
    await safeBatch(env, [
      await buildLogStmt(env, { question: title, hash, found: false, fromCache: false, durationMs, apiKeyId, error: msg, errorType: 'bad_input' }),
    ]);
    return {
      found: false, fromCache: false, question: title, answer: null,
      channel: null, model: null, durationMs, usage: null, error: msg,
      errorType: 'bad_input', httpStatus: null, rawRequest: null, rawResponse: null, attempts: null,
      invalidInput: true,
    };
  }

  // 查缓存（精确匹配：键 = 题干归一化 + 选项归一化；无选项时退化为旧版题干键，与存量缓存直接兼容）
  const cached = await env.DB.prepare(
    'SELECT id, question, answer FROM questions WHERE question_hash = ?'
  ).bind(hash).first<{ id: string; question: string; answer: string }>();

  if (cached) {
    const durationMs = Date.now() - startTime;

    // 命中计数 / 密钥用量 / 日志合并为一次 batch，且失败不影响返回答案
    await safeBatch(env, [
      env.DB.prepare(
        "UPDATE questions SET hit_count = hit_count + 1, updated_at = datetime('now') WHERE id = ?"
      ).bind(cached.id),
      apiKeyId
        ? env.DB.prepare(
            "UPDATE api_keys SET use_count = use_count + 1, last_used = datetime('now') WHERE id = ?"
          ).bind(apiKeyId)
        : null,
      await buildLogStmt(env, {
        question: title, hash, found: true, fromCache: true,
        answer: cached.answer, durationMs, apiKeyId,
      }),
    ]);

    return {
      found: true, fromCache: true, question: cached.question, answer: cached.answer,
      channel: null, model: null, durationMs, usage: null, error: null,
      errorType: null, httpStatus: null, rawRequest: null, rawResponse: null, attempts: null,
    };
  }

  // 兼容回退：本修复之前的存量条目哈希仅含题干。带选项的请求在新键未命中时查旧键（题干哈希），
  // 命中后必须校验选项归一化一致才采用——防止“题干相同、选项不同”的两道题串答案；
  // 不一致则视为未命中，走 AI 重新作答（新答案以新键入库，与旧条目隔离）。
  // 含 URL 的题目直接跳过旧键回退：旧条目键中的 URL 已被归一化打碎（标点剥离），
  // 与占位符形态必然不同，回退查询只会白多一次往返。
  let legacy: {
    row: { id: string; question: string; answer: string; type: string | null; options: string | null; source: string | null; ai_model: string | null };
    optionsMatch: boolean;
  } | null = null;

  if (optionsNorm && !hasUrls) {
    const titleOnlyHash = await questionHash(normalized);
    const row = await env.DB.prepare(
      'SELECT id, question, answer, type, options, source, ai_model FROM questions WHERE question_hash = ?'
    ).bind(titleOnlyHash).first<{
      id: string; question: string; answer: string; type: string | null;
      options: string | null; source: string | null; ai_model: string | null;
    }>();
    if (row) {
      legacy = { row, optionsMatch: row.options ? normalizeOptions(row.options) === optionsNorm : false };
    }
  }

  if (legacy && legacy.optionsMatch) {
    const row = legacy.row;
    const durationMs = Date.now() - startTime;

    // 命中计数 / 密钥用量 / 日志合并为一次 batch；同时以新键（题干+选项）回写一条变体，
    // 下次同题干同选项直接命中新键，免去每次的旧键回退查询（ON CONFLICT 保证幂等）
    await safeBatch(env, [
      env.DB.prepare(
        "UPDATE questions SET hit_count = hit_count + 1, updated_at = datetime('now') WHERE id = ?"
      ).bind(row.id),
      env.DB.prepare(
        `INSERT INTO questions (id, question, question_norm, question_hash, answer, type, options, source, ai_model, has_images, hit_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(question_hash) DO NOTHING`
      ).bind(
        uuid(), title, normalized, hash, row.answer,
        input.type || row.type, input.options || row.options,
        row.source || 'ai', row.ai_model, hasImages ? 1 : 0
      ),
      apiKeyId
        ? env.DB.prepare(
            "UPDATE api_keys SET use_count = use_count + 1, last_used = datetime('now') WHERE id = ?"
          ).bind(apiKeyId)
        : null,
      await buildLogStmt(env, {
        question: title, hash, found: true, fromCache: true,
        answer: row.answer, durationMs, apiKeyId,
      }),
    ]);

    return {
      found: true, fromCache: true, question: row.question, answer: row.answer,
      channel: null, model: null, durationMs, usage: null, error: null,
      errorType: null, httpStatus: null, rawRequest: null, rawResponse: null, attempts: null,
    };
  }

  // 未命中缓存，调用 AI（images 合并了内嵌图片 URL：图题走视觉模型；
  // inlineImages 为 OCS v2 直传的 base64 图，suggestionTitle/Options 为对应的 [图片N] 文本）
  try {
    const aiResult = await dispatchAI({
      title,
      type: input.type,
      options: input.options,
      images,
      inlineImages,
      suggestionTitle: input.suggestionTitle,
      suggestionOptions: input.suggestionOptions,
      imagePatterns,
      env,
    });

    const durationMs = Date.now() - startTime;

    // 入库门槛：空答案/拒答不入缓存。拒答文本一旦入库会永久污染缓存——
    // 该题此后永远直接命中拒答“答案”，不再走 AI。日志仍记录原始回答与尝试链供排查
    if (isRefusalAnswer(aiResult.content)) {
      const refusalMsg = 'AI 未给出有效答案（拒答/空答案），未入库';
      await safeBatch(env, [
        apiKeyId
          ? env.DB.prepare(
              "UPDATE api_keys SET use_count = use_count + 1, last_used = datetime('now') WHERE id = ?"
            ).bind(apiKeyId)
          : null,
        await buildLogStmt(env, {
          question: title, hash, found: false, fromCache: false,
          answer: aiResult.content, channel: aiResult.channelName, model: aiResult.model,
          durationMs, apiKeyId, error: refusalMsg, errorType: 'refusal',
          rawRequest: aiResult.rawRequest, rawResponse: aiResult.rawResponse,
          usage: aiResult.usage,
          httpStatus: aiResult.httpStatus,
          attempts: aiResult.attempts,
        }),
      ]);

      return {
        found: false, fromCache: false, question: title, answer: null,
        channel: aiResult.channelName, model: aiResult.model,
        durationMs, usage: aiResult.usage, error: refusalMsg,
        errorType: 'refusal', httpStatus: aiResult.httpStatus,
        rawRequest: aiResult.rawRequest, rawResponse: aiResult.rawResponse, attempts: aiResult.attempts,
      };
    }

    // 缓存写入 / 密钥用量 / 日志合并为一次 batch；写失败仅记日志，答案照常返回
    await safeBatch(env, [
      env.DB.prepare(
        `INSERT INTO questions (id, question, question_norm, question_hash, answer, type, options, source, ai_model, has_images, hit_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, 0)
         ON CONFLICT(question_hash) DO NOTHING`
      ).bind(
        uuid(), title, normalized, hash, aiResult.content,
        input.type || null, input.options || null,
        aiResult.model, hasImages ? 1 : 0
      ),
      apiKeyId
        ? env.DB.prepare(
            "UPDATE api_keys SET use_count = use_count + 1, last_used = datetime('now') WHERE id = ?"
          ).bind(apiKeyId)
        : null,
      await buildLogStmt(env, {
        question: title, hash, found: true, fromCache: false,
        answer: aiResult.content, channel: aiResult.channelName, model: aiResult.model,
        durationMs, apiKeyId,
        rawRequest: aiResult.rawRequest, rawResponse: aiResult.rawResponse,
        usage: aiResult.usage,
        httpStatus: aiResult.httpStatus, errorType: null,
        attempts: aiResult.attempts,
      }),
    ]);

    return {
      found: true, fromCache: false, question: title, answer: aiResult.content,
      channel: aiResult.channelName, model: aiResult.model,
      durationMs, usage: aiResult.usage, error: null,
      errorType: null, httpStatus: aiResult.httpStatus,
      rawRequest: aiResult.rawRequest, rawResponse: aiResult.rawResponse,
      attempts: aiResult.attempts,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    // AI 调度错误携带错误分类、原始请求/响应与首个失败模型，便于日志排查与模型归因
    const rawRequest = err instanceof AIError ? (err.rawRequest || null) : null;
    const rawResponse = err instanceof AIError ? (err.rawResponse || null) : null;
    const failChannel = err instanceof AIError ? (err.channel || null) : null;
    const errorType = err instanceof AIError ? err.errorType : null;
    const httpStatus = err instanceof AIError ? err.httpStatus : null;
    const failedAttempts = err instanceof AIError ? (err.attempts || null) : null;
    await safeBatch(env, [
      apiKeyId
        ? env.DB.prepare(
            "UPDATE api_keys SET use_count = use_count + 1, last_used = datetime('now') WHERE id = ?"
          ).bind(apiKeyId)
        : null,
      await buildLogStmt(env, {
        question: title, hash, found: false, fromCache: false,
        channel: failChannel,
        durationMs, apiKeyId, error: errMsg,
        errorType, httpStatus,
        rawRequest, rawResponse,
        attempts: failedAttempts,
      }),
    ]);

    return {
      found: false, fromCache: false, question: title, answer: null,
      channel: failChannel, model: null,
      durationMs, usage: null, error: errMsg,
      errorType, httpStatus,
      rawRequest, rawResponse, attempts: failedAttempts,
    };
  }
}
