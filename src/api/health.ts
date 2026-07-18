import type { Env } from '../types/env';
import { json } from '../utils/response';

/** 健康检查 */
export async function healthHandler(_request: Request, env: Env): Promise<Response> {
  let dbStatus = 'connected';
  try {
    await env.DB.prepare('SELECT 1').first();
  } catch {
    dbStatus = 'disconnected';
  }

  return json({
    status: 'ok',
    version: '1.0.0',
    db: dbStatus,
  });
}
