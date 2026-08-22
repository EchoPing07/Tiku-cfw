import { describe, it, expect } from 'vitest';
import { signJWT, verifyJWT } from './jwt';
import type { Env } from '../types/env';

const env = { JWT_SECRET: 'test-secret' } as Env;
const envOther = { JWT_SECRET: 'other-secret' } as Env;

/** 与实现一致的 HMAC-SHA256 hex 签名，用于手工构造畸形/过期 token */
async function signWith(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('JWT 签发与校验', () => {
  it('签发 → 校验通过', async () => {
    const token = await signJWT(env);
    expect(await verifyJWT(token, env)).toBe(true);
  });

  it('密钥不匹配校验失败', async () => {
    const token = await signJWT(env);
    expect(await verifyJWT(token, envOther)).toBe(false);
  });

  it('篡改 payload 校验失败', async () => {
    const token = await signJWT(env);
    const [h, , s] = token.split('.');
    const forged = b64url(JSON.stringify({ iat: 1, exp: 9999999999 }));
    expect(await verifyJWT(`${h}.${forged}.${s}`, env)).toBe(false);
  });

  it('alg 非 HS256（none 攻击）校验失败', async () => {
    const h = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const p = b64url(JSON.stringify({ exp: 9999999999 }));
    expect(await verifyJWT(`${h}.${p}.`, env)).toBe(false);
    expect(await verifyJWT(`${h}.${p}.${await signWith(env.JWT_SECRET, `${h}.${p}`)}`, env)).toBe(false);
  });

  it('过期 token 校验失败', async () => {
    const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const p = b64url(JSON.stringify({ iat: 1000, exp: 1000 }));
    const s = await signWith(env.JWT_SECRET, `${h}.${p}`);
    expect(await verifyJWT(`${h}.${p}.${s}`, env)).toBe(false);
  });

  it('畸形 token 校验失败而不抛异常', async () => {
    expect(await verifyJWT('', env)).toBe(false);
    expect(await verifyJWT('a.b', env)).toBe(false);
    expect(await verifyJWT('a.b.c.d', env)).toBe(false);
    expect(await verifyJWT('!!.!!.!!', env)).toBe(false);
    expect(await verifyJWT('eyJhbGd.IjoiMTIz.NotJson', env)).toBe(false);
  });
});
