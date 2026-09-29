/** 题目归一化：去除 HTML 标签、标点、空白等干扰内容 */
export function normalizeQuestion(question: string): string {
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

export interface NormalizedQuestion {
  /** 题干归一化（不含选项） */
  normalized: string;
  /** 选项归一化（未传选项或归一化为空时为空串） */
  optionsNorm: string;
  /**
   * 缓存键哈希：有选项时 = SHA-256(题干归一化 + '\u0000' + 选项归一化)，
   * 无选项时 = SHA-256(题干归一化)（与旧版键一致，存量无选项缓存直接兼容）。
   * 选项入键修复：题干相同、选项不同的题不再共享同一条缓存。
   */
  hash: string;
}

/** 归一化 + 哈希（题干 + 选项组合键），一步到位 */
export async function normalizeAndHash(
  question: string,
  options?: string
): Promise<NormalizedQuestion> {
  const normalized = normalizeQuestion(question);
  const optionsNorm = options ? normalizeOptions(options) : '';
  // 题干侧剥离控制字符：\u0000 是题干/选项分界符，不能让题干文本伪造边界。
  // 选项侧不可在此处再剥 \u0001（行分隔符在 join 后是键的一部分，剥掉会丢失选项条数信息，
  // 导致 {甲,乙} 与 {乙甲} 这类不同选项集碰撞）；选项行已在 normalizeOptions 内逐行清洗。
  const titlePart = normalized.replace(/[\u0000\u0001]/g, '');
  const hash = await questionHash(optionsNorm ? titlePart + '\u0000' + optionsNorm : titlePart);
  return { normalized, optionsNorm, hash };
}
