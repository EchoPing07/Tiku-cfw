import { describe, it, expect } from 'vitest';
import { probeResponse, searchHandler } from './search';
import type { Env } from '../types/env';

/**
 * OCS 5.1.0 起题库状态探测的行为（scripts/src/utils/ui.ts probeAnswerer）：
 *   1) 对 item.url 本身（即 /api/search）发 HEAD，405/501 时回退 GET；
 *   2) 只有 200–399 才算「连接成功」，否则面板显示「连接失败（状态码）」。
 * 因此本接口对非 POST 必须回 2xx，否则面板永远红色告警。
 */
describe('probeResponse（OCS 5.x 状态探测）', () => {
  it('HEAD 返回 2xx（OCS 首选探测方法，不会回退 GET）', async () => {
    const res = probeResponse('HEAD');
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('');
  });

  it('GET 返回 2xx 且是 JSON 说明（OCS 回退路径 / 人工浏览器打开）', async () => {
    const res = probeResponse('GET');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = await res.json() as { code: number; status: string };
    expect(body.code).toBe(1);
    expect(body.status).toBe('ok');
  });

  it('探测响应不含任何密钥或题库数据', async () => {
    const body = await probeResponse('GET').text();
    expect(body).not.toContain('tk_');
    expect(body).not.toContain('Bearer');
  });
});

describe('searchHandler：OCS 5.x 探测路径不被 405 拦截', () => {
  const env = {} as Env; // 探测路径不应触达 D1

  it('HEAD /api/search → 200（旧行为是 405 → 面板「连接失败（405）」）', async () => {
    const res = await searchHandler(new Request('https://t.example.com/api/search?t=1', { method: 'HEAD' }), env);
    expect(res.status).toBe(200);
  });

  it('GET /api/search → 200', async () => {
    const res = await searchHandler(new Request('https://t.example.com/api/search?t=1'), env);
    expect(res.status).toBe(200);
  });

  it('OPTIONS 预检仍走 204', async () => {
    const res = await searchHandler(new Request('https://t.example.com/api/search', { method: 'OPTIONS' }), env);
    expect(res.status).toBe(204);
  });

  it('PUT/DELETE 等其它方法同属探测兜底（2xx，不误报连接失败）', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const res = await searchHandler(new Request('https://t.example.com/api/search', { method }), env);
      expect(res.status).toBe(200);
    }
  });

  it('POST 仍走鉴权（无 Bearer → 401，证明未被探测分支吞掉）', async () => {
    const res = await searchHandler(
      new Request('https://t.example.com/api/search', { method: 'POST', body: '{"title":"1+1"}' }),
      env
    );
    expect(res.status).toBe(401);
  });
});
