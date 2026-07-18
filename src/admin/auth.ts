import type { Env } from '../types/env';
import { json, error, options } from '../utils/response';
import { requireAuth } from '../auth/middleware';
import { signJWT } from '../auth/jwt';

/** 管理员登录 */
export async function adminLoginHandler(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return options();
  if (request.method !== 'POST') return error('仅支持 POST 请求', 405);

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return error('请求体格式错误');
  }

  const password = body.password || '';
  const adminPassword = env.ADMIN_PASSWORD || 'password';

  if (password !== adminPassword) {
    return error('密码错误', 401);
  }

  const token = await signJWT(env);
  return json({ token, msg: '登录成功' });
}

/** 验证登录状态 */
export async function adminVerifyHandler(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return options();

  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  return json({ valid: true });
}
