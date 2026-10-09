/**
 * Worker 端图片下载与 base64 内联（对标 ZError commands.rs fetch_image_as_base64）。
 *
 * 超星/智慧树等图床有 Referer/UA 防盗链，原 URL 交给厂商代抓大概率 403；本模块在
 * Worker 侧伪装浏览器下载并内联，失败项回退原始 URL（厂商代抓兜底）。
 * 策略：桌面 Chrome UA + 图片 Accept + 按域名定向 Referer（chaoxing/zhihuishu/自身
 * origin），失败后移动端 UA 重试一次。
 *
 * 限制：单图源 ≤ 5MB，内联总量 ≤ 12MB；单图总超时 10s；魔数嗅探真实类型
 * （不吃响应头，可拦 HTML 错误页伪装 200 + image/*）。Worker 无法解码图像，
 * ZError 的白底重绘/最小尺寸放大不可用（厂商补丁，非必需）。
 */

export interface ImageFetchEntry {
  /** 结果映射键（归一化 URL，与消息构建侧一致） */
  key: string;
  /** 实际抓取的 URL（可访问形态） */
  url: string;
}

export interface ImageFetchLimits {
  /** 单图总预算（毫秒，含两档策略重试） */
  perImageTimeoutMs: number;
  /** 单图源字节上限 */
  maxImageBytes: number;
  /** 全部内联图源字节总量上限 */
  maxTotalBytes: number;
}

export const DEFAULT_IMAGE_FETCH_LIMITS: ImageFetchLimits = {
  perImageTimeoutMs: 10_000,
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
};

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

/** 按域名定向伪造 Referer：超星/智慧树图床校验站内 Referer */
function refererFor(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes('chaoxing.com')) return 'https://mooc1-1.chaoxing.com/';
    if (host.includes('zhihuishu.com')) return 'https://www.zhihuishu.com/';
    return u.origin + '/';
  } catch {
    return 'https://www.google.com/';
  }
}

/** 魔数嗅探真实图片类型（不吃响应头；返回 MIME 或 null=非图片内容） */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50   // WEBP
  ) {
    return 'image/webp';
  }
  // SVG（文本格式）：开头若干字符内出现 <svg / <?xml 声明
  const head = new TextDecoder('utf-8').decode(b.subarray(0, 512)).trim().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!doctype svg')) {
    return 'image/svg+xml';
  }
  return null;
}

/** 字节转 base64（分块防超大数组展开爆栈） */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function fetchOnce(
  url: string,
  referer: string,
  ua: string,
  deadline: number
): Promise<Uint8Array> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('图片抓取超时');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': ua,
        Accept: 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: referer,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** 单图下载：桌面 UA 失败（含非图片内容/超限）后移动端 UA 重试，预算内尽力 */
async function fetchImageBytes(url: string, limits: ImageFetchLimits): Promise<Uint8Array> {
  const deadline = Date.now() + limits.perImageTimeoutMs;
  const referer = refererFor(url);
  let lastError = '图片下载失败';

  for (const ua of [DESKTOP_UA, MOBILE_UA]) {
    try {
      const bytes = await fetchOnce(url, referer, ua, deadline);
      if (bytes.length > limits.maxImageBytes) throw new Error(`图片过大（${bytes.length} 字节）`);
      if (!sniffImageType(bytes)) throw new Error('内容不是图片');
      return bytes;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (Date.now() >= deadline) break;
    }
  }
  throw new Error(lastError);
}

/**
 * 批量抓取并转 base64 data URL。并行下载、串行内联；单图失败不影响其他图（失败项
 * 不出现在结果 Map，调用方回退原始 URL）。本函数不抛错（内部全捕获）。
 */
export async function fetchImagesAsDataUrls(
  entries: ImageFetchEntry[],
  limits: ImageFetchLimits = DEFAULT_IMAGE_FETCH_LIMITS
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const valid = entries.filter((e) => e && e.key && typeof e.url === 'string' && /^https?:\/\//i.test(e.url));
  if (valid.length === 0) return result;

  const settled = await Promise.allSettled(
    valid.map(async (e) => ({ key: e.key, bytes: await fetchImageBytes(e.url, limits) }))
  );

  let totalBytes = 0;
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue; // 单图失败：跳过（回退原始 URL）
    const { key, bytes } = s.value;
    if (bytes.length > limits.maxImageBytes) continue;
    if (totalBytes + bytes.length > limits.maxTotalBytes) continue; // 超总预算：不内联
    totalBytes += bytes.length;
    const mime = sniffImageType(bytes);
    if (!mime) continue; // 理论不可达（fetchImageBytes 已嗅探），双保险
    result.set(key, `data:${mime};base64,${bytesToBase64(bytes)}`);
  }
  return result;
}
