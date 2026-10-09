/** 题目归一化：去除 HTML 标签、标点、空白等干扰内容 */
export function normalizeQuestion(question: string): string {
  // 注意：URL（<img> src、裸链接）必须在本函数之前由 extractUrlInfo 摘出并以
  // __URL__ 占位替换——否则 <img> 里的 URL 随标签一起被剥离，两道图不同、
  // 周围文字相同的题会归一化到同一缓存键，互相串错误答案。
  return question
    .replace(/<[^>]+>/g, '')                         // HTML 标签
    .replace(/&[a-z]+;/gi, ' ')                      // HTML 实体 → 空格
    .replace(/【[^】]*】/g, '')                        // 【单选题】等标记
    .replace(/\(\d+分\)/g, '')                        // (5分) 分值
    .replace(/（\d+分）/g, '')                         // （5分）全角分值
    .replace(/[\s\u3000]+/g, '')                      // 所有空白含全角空格
    .replace(/[，。、；：！？""''（）【】《》]/g, '')     // 中文标点
    .replace(/[,.!;:?()"'\[\]{}<>]/g, '')             // 英文标点
    .toLowerCase()
    .trim();
}

/** 行首选项字母标签：A. / A、 / A） / Ａ． 等（容忍标签前空白，如 HTML 剥离后）；捕获分隔符用于元素串守卫 */
const OPTION_LABEL_RE = /^(\s*)([A-Za-z\uFF21-\uFF3A\uFF41-\uFF5A])\s*([.、．:：)）])\s*/;

/** 化学元素串形态：C、H、O、N（1-2 个字母的顿号分隔序列） */
const ELEMENT_LIST_RE = /^[A-Za-z]{1,2}(、[A-Za-z]{1,2})*$/;

/**
 * 剥离行首选项字母标签。
 * 元素串守卫（ZError 同款）：分隔符为顿号且剩余部分形如化学元素串（如 C、H、O 的“H、O”）时，
 * 该行大概率本身就是无标签的元素列表选项，保留整行——否则无标签的“C、H、O”会被误剥成“H、O”，
 * 与带标签的“A. H、O”选项集碰撞。
 */
function stripOptionLabel(line: string): string {
  const m = line.match(OPTION_LABEL_RE);
  if (!m) return line;
  const rest = line.slice(m[0].length);
  if (m[3] === '、' && ELEMENT_LIST_RE.test(rest.replace(/\s+/g, ''))) return line;
  return rest;
}

/**
 * 选项归一化（参与缓存键）：按行拆分 → 去 HTML/行首选项字母标签/空白 → 小写 → 排序 → join。
 * 排序消除选项顺序差异（A\nB 与 B\nA 视为同一组选项）；行首标签剥离消除 A. / A、 标注风格差异。
 * 注意：\u0000/\u0001 控制字符必须在逐行阶段清洗（join 之后不可再剥，否则丢失选项条数信息）。
 */
export function normalizeOptions(options: string): string {
  return options
    .split(/\r?\n/)
    .map(line => {
      let s = line
        .replace(/<[^>]+>/g, ' ')                                 // HTML 标签（与题干归一化对齐）
        .replace(/&[a-z]+;/gi, ' ')                               // HTML 实体
        .replace(/[\u0000\u0001]/g, '');                          // 行内控制字符（防伪造行/键分隔符）
      s = stripOptionLabel(s);
      return s.replace(/[\s\u3000]+/g, '').toLowerCase();          // 行内所有空白（含全角空格）
    })
    .filter(s => s.length > 0)
    .sort()
    .join('\u0001');
}

/** SHA-256 哈希（CF Worker 的 crypto.subtle 不支持 MD5） */
export async function questionHash(normalized: string): Promise<string> {
  const data = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

import { extractUrlInfo } from '../utils/question-images';

export interface NormalizedQuestion {
  /** 题干归一化（不含选项；URL 已替换为 __url__ 占位符） */
  normalized: string;
  /** 选项归一化（未传选项或归一化为空时为空串） */
  optionsNorm: string;
  /**
   * 缓存键哈希：
   * - 无选项无 URL：SHA-256(题干归一化)（与旧版键一致，存量缓存直接兼容）；
   * - 有选项：SHA-256(题干归一化 + '\u0000' + 选项归一化)；
   * - 有 URL：再追加 '\u0000' + 排序去重 URL 集合（URL 是图题的身份证：
   *   同图不同 HTML 包装 → 同键命中；不同图 → 异键隔离）。
   */
  hash: string;
  /** 图片性 URL（Tier 1/1.5，按首次出现顺序去重），供视觉路由 */
  imageUrls: string[];
  /** 是否提取到任何 URL（含 Tier 2）；有 URL 时旧键回退查询必然 miss，可跳过 */
  hasUrls: boolean;
}

/** 归一化 + 哈希（题干 + 选项 + URL 集合组合键），一步到位 */
export async function normalizeAndHash(
  question: string,
  options?: string,
  opts?: { imagePatterns?: RegExp[] }
): Promise<NormalizedQuestion> {
  const extractOpts = opts?.imagePatterns ? { patterns: opts.imagePatterns } : undefined;
  const titleInfo = extractUrlInfo(question, extractOpts);
  const optionsInfo = options ? extractUrlInfo(options, extractOpts) : null;

  const normalized = normalizeQuestion(titleInfo.text);
  const optionsNorm = optionsInfo ? normalizeOptions(optionsInfo.text) : '';

  // URL 集合（排序去重）参与键：身份独立于题干文本——既不丢（不会碰撞）也不扰（不污染文本归一化）
  const urlSet = [...new Set([...titleInfo.urls, ...(optionsInfo?.urls ?? [])])].filter(Boolean).sort();

  // 题干侧剥离控制字符：\u0000 是键分界符，不能让题干文本伪造边界。
  // 选项侧不可在此处再剥 \u0001（行分隔符在 join 后是键的一部分，剥掉会丢失选项条数信息）；
  // 选项行已在 normalizeOptions 内逐行清洗。
  const titlePart = normalized.replace(/[\u0000\u0001]/g, '');
  let key = optionsNorm ? titlePart + '\u0000' + optionsNorm : titlePart;
  if (urlSet.length > 0) key += '\u0000' + urlSet.join('\n');
  const hash = await questionHash(key);

  const imageUrls = [...new Set([...titleInfo.imageUrls, ...(optionsInfo?.imageUrls ?? [])])];
  return { normalized, optionsNorm, hash, imageUrls, hasUrls: urlSet.length > 0 };
}
