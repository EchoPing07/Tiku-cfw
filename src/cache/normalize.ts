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

/** SHA-256 哈希（CF Worker 的 crypto.subtle 不支持 MD5） */
export async function questionHash(normalized: string): Promise<string> {
  const data = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 归一化 + 哈希，一步到位 */
export async function normalizeAndHash(question: string): Promise<{ normalized: string; hash: string }> {
  const normalized = normalizeQuestion(question);
  const hash = await questionHash(normalized);
  return { normalized, hash };
}
