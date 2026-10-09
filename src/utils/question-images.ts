/**
 * 题目文本中的图片/URL 提取（对标 ZError questionImage.ts + database.rs extract_urls）。
 *
 * OCS 图题的图片 URL 内嵌在 title/options 文本里（`<img>` 或裸 URL），而非独立
 * images 数组。本模块：① 提取并清洗 URL（尾随标点、图片后缀截断、超星 LaTeX 截断、
 * 裸域名过滤）；② 输出占位替换后的文本（缓存归一化：同图不同包装 → 同键）；
 * ③ 输出图文交错分段（视觉消息：图片保持原文位置）。
 *
 * 图片性分级：Tier 1 = <img>/markdown 提取的 URL 或带图片后缀的裸 URL；
 * Tier 1.5 = 命中 image_url_patterns（默认 /ananas/，存 settings 可热更）；
 * Tier 2 = 其余带路径 URL，仅入缓存键，不路由视觉模型。
 * 裸域名（协议后无 `/`）完全忽略：多为站点水印，入键只会造成同题异键。
 */

/** URL 占位符：进入归一化文本，`<img>` 包装 / 裸文本 / markdown 三形态归一后相同 */
export const URL_PLACEHOLDER = '__URL__';

/** 图片性 URL 模式默认值（正则源字符串）：/ananas/ 覆盖超星 latex/editor 等无后缀图床路径 */
export const DEFAULT_IMAGE_URL_PATTERN_SOURCES: readonly string[] = ['/ananas/'];

const defaultPatterns = (): RegExp[] => DEFAULT_IMAGE_URL_PATTERN_SOURCES.map((s) => new RegExp(s, 'i'));

/**
 * 解析 settings.image_url_patterns（JSON 字符串数组，正则源）。
 * 空/非法 JSON/非数组/全部非法 → 回退默认模式；个别非法条目跳过（不阻塞搜题）。
 */
export function parseImagePatterns(raw: string | null | undefined): RegExp[] {
  if (!raw || !raw.trim()) return defaultPatterns();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultPatterns();
  }
  if (!Array.isArray(parsed)) return defaultPatterns();
  const out: RegExp[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string' || !item.trim()) continue;
    try {
      out.push(new RegExp(item, 'i'));
    } catch {
      // 非法正则：跳过该条
    }
  }
  return out.length > 0 ? out : defaultPatterns();
}

export interface UrlExtractOptions {
  /** 图片性 URL 模式（默认 /ananas/；来自 settings.image_url_patterns） */
  patterns?: RegExp[];
}

function resolvePatterns(opts?: UrlExtractOptions): RegExp[] {
  return opts?.patterns ?? defaultPatterns();
}

/** 提取结果：一个 URL 出现在原文中的匹配（位置信息供占位替换与图文交错） */
export interface ImageMatch {
  /** 归一化 URL（缓存身份用：已实体解码、剥尾随标点、超星 LaTeX 截断） */
  url: string;
  /** 实际抓取/回退用的 URL（不做 LaTeX 截断，保证可直接访问） */
  fetchUrl: string;
  /** 原文起始位置（<img> 为整个标签的起点） */
  start: number;
  /** 占位替换终点（不含 trailingText） */
  replaceEnd: number;
  /** 原文匹配终点（含 trailingText） */
  end: number;
  /** 图片后缀截断后归还文本流的粘连内容（如 .png 后紧跟的单位/编号） */
  trailingText: string;
  /** 是否图片性素材（参与视觉路由与图文交错） */
  isImage: boolean;
}

// <img src="..."> / <img src='...'> / <img src=...>（大小写不敏感；span 覆盖整个标签）
const IMG_TAG_RE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
// ![alt](url) / ![alt](<url> "title")
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^\s)]+))[^)]*\)/gi;
// 裸 URL：含 () 以支持维基式带括号路径；不含引号（引号属于 HTML 属性边界）；i 标志兼容大写协议头
const RAW_URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/#@!$&*+,;%=?()]+/gi;

/** 图片扩展名（出现在路径中即视为图片后缀；不做字母数字前瞻——粘连文本正是要截断的对象） */
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|tiff?)/gi;

/** 尾随标点（URL 不以这些字符结尾；全角标点因不在 URL 字符类中不会出现在裸 URL 匹配尾部） */
const TRAILING_PUNCT = new Set([
  '.', ',', ';', '!', '?', ':',
  '，', '。', '；', '！', '？', '：', '、',
  '"', "'", '“', '”', '‘', '’', '»', '「', '」', '『', '』', '》',
]);

const countChar = (s: string, ch: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
};

/**
 * 剥离尾随标点（在原文坐标上操作，保证 replaceEnd 可靠）：
 * `)` 仅在数量多于 `(` 时剥离（成对括号属 URL 参数）；尾随孤立 `(` ── 属后续文本
 * （如 `https://x/a.png(见下图)`）── 与其余标点/引号直接剥离。
 */
function stripTrailingPunct(s: string): string {
  let out = s;
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last === ')') {
      if (countChar(out, ')') <= countChar(out, '(')) return out;
      out = out.slice(0, -1);
    } else if (last === '(') {
      out = out.slice(0, -1);
    } else if (TRAILING_PUNCT.has(last)) {
      out = out.slice(0, -1);
    } else {
      return out;
    }
  }
  return out;
}

/** 找最后一个图片扩展名的结束位置（-1 = 无）；无字母数字前瞻：`.png3` 在 `.png` 处截断，`3` 归还文本 */
function findImageExtCut(s: string): number {
  let cut = -1;
  IMAGE_EXT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMAGE_EXT_RE.exec(s)) !== null) {
    cut = m.index + m[0].length;
  }
  return cut;
}

/** URL 中的 HTML 实体解码（&amp; 等：属性值与 HTML 转义文本中的 URL 与裸 URL 是同一张图） */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:#0?39|#x27|apos);/gi, "'");
}

/** 路径（去 query/fragment）以图片扩展名结尾 */
function hasImageExt(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0];
  IMAGE_EXT_RE.lastIndex = 0;
  return IMAGE_EXT_RE.test(path);
}

interface CleanedUrl {
  url: string;
  fetchUrl: string;
  trailing: string;
  /** 原文坐标：URL 部分长度（matchStart + replaceLen = 占位替换终点） */
  replaceLen: number;
  /** 协议后含 `/`（裸域名不算素材） */
  hasPath: boolean;
}

/**
 * 清洗单个 URL 匹配：① 剥尾随标点（括号守卫）；② 图片后缀截断——`.png` 后粘连的
 * 字符（下划线/单位/编号）归还文本流，后跟 `?`/`#` 视为正常 query 保留；③ 实体解码；
 * ④ 超星 LaTeX 身份截断：`mooc*.chaoxing.com/ananas/latex/p/<id><extra>` 截到 `<id>`，
 * 同图不同渲染参数归一为同一 URL（fetchUrl 不截断，保证可访问）。
 * 返回 null = 完全忽略（裸域名裸 URL 留在原文，不参与身份）。
 */
function cleanUrl(raw: string): CleanedUrl | null {
  let kept = stripTrailingPunct(raw);
  let trailing = '';

  const cut = findImageExtCut(kept);
  if (cut !== -1 && cut < kept.length && !/^[?#]/.test(kept.slice(cut))) {
    // 后缀后粘连的是内容（单位/编号/下划线），不是 query —— 截断并归还文本流
    trailing = kept.slice(cut);
    kept = kept.slice(0, cut);
  }

  const decoded = decodeEntities(kept);
  if (!/^https?:\/\//i.test(decoded)) return null;

  const rest = decoded.replace(/^https?:\/\//i, '');
  const hasPath = rest.includes('/');
  if (!hasPath) return null; // 裸域名：忽略（<img> 调用方另行处理为非图片素材）

  const fetchUrl = decoded;
  let url = decoded;
  const latex = decoded.match(/^https?:\/\/[^/]*chaoxing\.com\/ananas\/latex\/p\/\d+/i);
  if (latex) url = latex[0];

  return { url, fetchUrl, trailing, replaceLen: kept.length, hasPath };
}

function overlaps(start: number, end: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => start < e && s < end);
}

/** 提取文本中全部 URL 匹配（img 标签 → markdown → 裸 URL，后者跳过已消费区间） */
export function extractImageMatches(text: string, opts?: UrlExtractOptions): ImageMatch[] {
  const source = text || '';
  if (!source) return [];
  const patterns = resolvePatterns(opts);

  const matches: ImageMatch[] = [];
  const consumed: Array<[number, number]> = [];

  const push = (m: ImageMatch) => {
    matches.push(m);
    consumed.push([m.start, m.end]);
  };

  // 1) <img> 标签：src 属性值（三种引号形态）；span 覆盖整个标签
  IMG_TAG_RE.lastIndex = 0;
  for (const m of source.matchAll(IMG_TAG_RE)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    const cleaned = raw ? cleanUrl(raw) : null;
    if (!cleaned) continue; // 裸域名 src：占位/坏图，跳过（留在原文，与旧行为一致）
    const start = m.index!;
    const end = start + m[0].length;
    if (overlaps(start, end, consumed)) continue;
    // img 标签表达的就是图片意图
    push({
      url: cleaned.url,
      fetchUrl: cleaned.fetchUrl,
      start,
      replaceEnd: end,
      end,
      trailingText: '',
      isImage: cleaned.hasPath,
    });
  }

  // 2) markdown 图片
  MD_IMAGE_RE.lastIndex = 0;
  for (const m of source.matchAll(MD_IMAGE_RE)) {
    const raw = (m[1] ?? m[2] ?? '').trim().replace(/^<|>$/g, '');
    const cleaned = raw ? cleanUrl(raw) : null;
    if (!cleaned) continue;    const start = m.index!;
    const end = start + m[0].length;
    if (overlaps(start, end, consumed)) continue;
    push({
      url: cleaned.url,
      fetchUrl: cleaned.fetchUrl,
      start,
      replaceEnd: end,
      end,
      trailingText: '',
      isImage: cleaned.hasPath,
    });
  }

  // 3) 裸 URL（跳过已被 img/markdown 消费的区间）
  RAW_URL_RE.lastIndex = 0;
  for (const m of source.matchAll(RAW_URL_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (overlaps(start, end, consumed)) continue;
    const cleaned = cleanUrl(m[0]);
    if (!cleaned) continue; // 裸域名裸 URL：完全忽略（留在原文，与旧行为一致）
    const isImage = hasImageExt(cleaned.url) || patterns.some((p) => p.test(cleaned.url));
    push({
      url: cleaned.url,
      fetchUrl: cleaned.fetchUrl,
      start,
      replaceEnd: start + cleaned.replaceLen,
      end,
      trailingText: cleaned.trailing,
      isImage,
    });
  }

  matches.sort((a, b) => a.start - b.start || a.end - b.end);
  return matches;
}

export interface UrlExtractResult {
  /** 所有 URL 替换为占位符后的文本（trailingText 归还文本流，不丢内容） */
  text: string;
  /** 全部清洗后 URL（含 Tier 2，按出现顺序，未去重——缓存身份用） */
  urls: string[];
  /** 图片性 URL（Tier 1/1.5，按首次出现顺序去重——视觉路由用） */
  imageUrls: string[];
}

/** 提取 URL 并输出占位替换后的文本（供缓存归一化：所有 URL → __URL__） */
export function extractUrlInfo(text: string, opts?: UrlExtractOptions): UrlExtractResult {
  const source = text || '';
  const matches = extractImageMatches(source, opts);
  if (matches.length === 0) return { text: source, urls: [], imageUrls: [] };

  let out = '';
  let cursor = 0;
  const urls: string[] = [];
  const imageUrls: string[] = [];
  const seenImage = new Set<string>();

  for (const m of matches) {
    if (m.start < cursor) continue; // 防御：跳过意外重叠
    out += source.slice(cursor, m.start) + URL_PLACEHOLDER + m.trailingText;
    cursor = m.end;
    urls.push(m.url);
    if (m.isImage && !seenImage.has(m.url)) {
      seenImage.add(m.url);
      imageUrls.push(m.url);
    }
  }
  out += source.slice(cursor);
  return { text: out, urls, imageUrls };
}

export interface TextImagePart {
  type: 'text' | 'image';
  text?: string;
  /** 归一化 URL（与抓取结果映射的键一致） */
  url?: string;
  /** 可访问形态 URL（抓取失败回退用） */
  fetchUrl?: string;
}

/**
 * 图文交错分段（供视觉消息构建）：仅图片性 URL 变为 image 段，
 * Tier 2 URL 保留在 text 段原文中（模型仍能看到链接文本）。
 */
export function splitTextImageParts(text: string, opts?: UrlExtractOptions): TextImagePart[] {
  const source = text || '';
  if (!source) return [{ type: 'text', text: '' }];

  const matches = extractImageMatches(source, opts).filter((m) => m.isImage);
  if (matches.length === 0) return [{ type: 'text', text: source }];

  const parts: TextImagePart[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue;
    if (m.start > cursor) parts.push({ type: 'text', text: source.slice(cursor, m.start) });
    parts.push({ type: 'image', url: m.url, fetchUrl: m.fetchUrl });
    cursor = m.replaceEnd; // trailingText 归还到下一段文本
  }
  if (cursor < source.length) parts.push({ type: 'text', text: source.slice(cursor) });
  return parts.length > 0 ? parts : [{ type: 'text', text: source }];
}
