import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchImagesAsDataUrls, sniffImageType, DEFAULT_IMAGE_FETCH_LIMITS } from './image-fetch';

/** 最小 1x1 PNG（真实魔数） */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);
const GIF_BYTES = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function pngResponse(bytes: Uint8Array = PNG_BYTES, status = 200): Response {
  return new Response(bytes as unknown as BodyInit, {
    status,
    headers: { 'Content-Type': 'image/png' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sniffImageType：魔数嗅探', () => {
  it('识别 PNG/JPEG/GIF/WebP/BMP/SVG', () => {
    expect(sniffImageType(PNG_BYTES)).toBe('image/png');
    expect(sniffImageType(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffImageType(GIF_BYTES)).toBe('image/gif');
    expect(sniffImageType(Uint8Array.from([0x42, 0x4d, 0x00, 0x00]))).toBe('image/bmp');
    expect(
      sniffImageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))
    ).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      'image/svg+xml'
    );
  });

  it('HTML 错误页伪装 200 + image 头也被拒绝（不吃响应头）', () => {
    expect(sniffImageType(new TextEncoder().encode('<!DOCTYPE html><html>403</html>'))).toBeNull();
    expect(sniffImageType(Uint8Array.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    expect(sniffImageType(Uint8Array.from([0x89]))).toBeNull();
  });
});

describe('fetchImagesAsDataUrls', () => {
  it('成功下载转 base64 data URL（键为归一化 URL）', async () => {
    fetchMock.mockResolvedValue(pngResponse());
    const m = await fetchImagesAsDataUrls([{ key: 'https://x/a', url: 'https://x/a.png' }]);
    expect(m.size).toBe(1);
    expect(m.get('https://x/a')).toMatch(/^data:image\/png;base64,/);
  });

  it('防盗链伪装：超星域名带定向 Referer，桌面 Chrome UA', async () => {
    fetchMock.mockResolvedValue(pngResponse());
    await fetchImagesAsDataUrls([{ key: 'k', url: 'https://mooc1.chaoxing.com/ananas/latex/p/1.png' }]);
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Referer']).toBe('https://mooc1-1.chaoxing.com/');
    expect(headers['User-Agent']).toContain('Mozilla/5.0 (Windows NT 10.0');
  });

  it('智慧树域名定向 Referer，未知域名用自身 origin', async () => {
    fetchMock.mockResolvedValue(pngResponse());
    await fetchImagesAsDataUrls([
      { key: 'a', url: 'https://img.zhihuishu.com/zhs_img/1.png' },
      { key: 'b', url: 'https://cdn.example.com/i/1.png' },
    ]);
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>)['Referer']).toBe(
      'https://www.zhihuishu.com/'
    );
    expect((fetchMock.mock.calls[1][1].headers as Record<string, string>)['Referer']).toBe(
      'https://cdn.example.com/'
    );
  });

  it('首档 403 后用移动端 UA 重试成功', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(pngResponse());
    const m = await fetchImagesAsDataUrls([{ key: 'k', url: 'https://x/a.png' }]);
    expect(m.size).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1].headers as Record<string, string>)['User-Agent']).toContain('iPhone');
  });

  it('两档均失败：结果不含该键（调用方回退原始 URL）', async () => {
    fetchMock.mockResolvedValue(new Response('denied', { status: 403 }));
    const m = await fetchImagesAsDataUrls([{ key: 'k', url: 'https://x/a.png' }]);
    expect(m.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('非图片内容（HTML 页）不入结果', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>err</html>', { status: 200, headers: { 'Content-Type': 'image/png' } })
    );
    const m = await fetchImagesAsDataUrls([{ key: 'k', url: 'https://x/a.png' }]);
    expect(m.size).toBe(0);
  });

  it('单图超限不入结果', async () => {
    const big = new Uint8Array(DEFAULT_IMAGE_FETCH_LIMITS.maxImageBytes + 1);
    big.set(PNG_BYTES.subarray(0, 8));
    fetchMock.mockResolvedValue(pngResponse(big));
    const m = await fetchImagesAsDataUrls([{ key: 'k', url: 'https://x/a.png' }]);
    expect(m.size).toBe(0);
  });

  it('总量超预算：后续图不内联（按序止付）', async () => {
    // 用小 limits 隔离测试：单图上限 100B、总量 150B，两张各 100B → 第二张止付
    const limits = { perImageTimeoutMs: 5_000, maxImageBytes: 100, maxTotalBytes: 150 };
    const img = new Uint8Array(100);
    img.set(PNG_BYTES.subarray(0, 8));
    fetchMock.mockResolvedValue(pngResponse(img));
    const m = await fetchImagesAsDataUrls(
      [
        { key: 'a', url: 'https://x/a.png' },
        { key: 'b', url: 'https://x/b.png' },
      ],
      limits
    );
    expect(m.has('a')).toBe(true);
    expect(m.has('b')).toBe(false);
  });

  it('单图失败不影响其他图（并行 allSettled）', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('bad')) throw new Error('network down');
      return pngResponse();
    });
    const m = await fetchImagesAsDataUrls([
      { key: 'a', url: 'https://x/a.png' },
      { key: 'bad', url: 'https://x/bad.png' },
    ]);
    expect(m.has('a')).toBe(true);
    expect(m.has('bad')).toBe(false);
  });

  it('非 http(s) 输入直接忽略', async () => {
    const m = await fetchImagesAsDataUrls([
      { key: 'a', url: 'javascript:alert(1)' },
      { key: '', url: 'https://x/a.png' },
    ]);
    expect(m.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('单图总超时（两档共享预算）：超时后不再重试', async () => {
    // 固定时间快进：首档耗尽全部预算
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      fetchMock.mockImplementation(async () => {
        now += 10_500; // 首次尝试即超出单图预算
        throw new Error('slow');
      });
      const m = await fetchImagesAsDataUrls([{ key: 'k', url: 'https://x/a.png' }]);
      expect(m.size).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1); // 预算耗尽，不重试第二档
    } finally {
      clock.mockRestore();
    }
  });
});
