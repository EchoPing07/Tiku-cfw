import type { Env } from '../types/env';

/** Base64Url 编码 */
function base64UrlEncode(data: string): string {
  return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Base64Url 解码 */
function base64UrlDecode(data: string): string {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded);
}

/** HMAC-SHA256 签名 */
async function sign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 签发 JWT（有效期 24 小时） */
export async function signJWT(env: Env): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(JSON.stringify({
    iat: now,
    exp: now + 86400,
  }));
  const signature = await sign(`${header}.${payload}`, env.JWT_SECRET);
  return `${header}.${payload}.${signature}`;
}

/** 验证 JWT，返回是否有效 */
export async function verifyJWT(token: string, env: Env): Promise<boolean> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;

    // 校验算法，防止 alg 混淆/none 攻击
    try {
      const header = JSON.parse(base64UrlDecode(parts[0]));
      if (header.alg !== 'HS256') return false;
    } catch {
      return false;
    }

    const expectedSig = await sign(`${parts[0]}.${parts[1]}`, env.JWT_SECRET);
    if (expectedSig !== parts[2]) return false;

    const payload = JSON.parse(base64UrlDecode(parts[1]));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return false;

    return true;
  } catch {
    return false;
  }
}

/** 从请求中提取 Bearer token */
export function extractBearer(request: Request): string | null {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}
