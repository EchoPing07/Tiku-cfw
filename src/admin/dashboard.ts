import type { Env } from '../types/env';
import { json, options } from '../utils/response';
import { requireAuth } from '../auth/middleware';

/** 仪表盘统计 */
export async function dashboardHandler(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return options();

  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  const db = env.DB;

  // 题目总数
  const totalQuestions = await db.prepare('SELECT COUNT(*) as count FROM questions').first<{ count: number }>();

  // 今日新增
  const todayNew = await db.prepare(
    `SELECT COUNT(*) as count FROM questions WHERE date(created_at) = date('now')`
  ).first<{ count: number }>();

  // 本周缓存命中率
  const weekStats = await db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN from_cache = 1 THEN 1 ELSE 0 END) as cached
     FROM search_logs
     WHERE created_at >= datetime('now', '-7 days')`
  ).first<{ total: number; cached: number }>();

  const hitRate = weekStats?.total ? ((weekStats.cached / weekStats.total) * 100).toFixed(1) : '0.0';

  // 本周 AI 调用次数
  const weekAI = await db.prepare(
    `SELECT COUNT(*) as count FROM search_logs
     WHERE from_cache = 0 AND found = 1 AND created_at >= datetime('now', '-7 days')`
  ).first<{ count: number }>();

  // 本周 API 请求次数
  const weekRequests = weekStats?.total || 0;

  // 题型分布
  const typeDist = await db.prepare(
    `SELECT type, COUNT(*) as count FROM questions GROUP BY type ORDER BY count DESC`
  ).all<{ type: string; count: number }>();

  // 最近搜索记录（10条）
  const recentLogs = await db.prepare(
    `SELECT question, found, from_cache, ai_channel, error, created_at
     FROM search_logs ORDER BY created_at DESC LIMIT 10`
  ).all<{
    question: string; found: number; from_cache: number;
    ai_channel: string | null; error: string | null; created_at: string
  }>();

  // 渠道统计
  const channels = await db.prepare(
    `SELECT type, COUNT(*) as count, SUM(enabled) as enabled_count FROM ai_channels GROUP BY type`
  ).all<{ type: string; count: number; enabled_count: number }>();

  return json({
    stats: {
      totalQuestions: totalQuestions?.count || 0,
      todayNew: todayNew?.count || 0,
      hitRate: `${hitRate}%`,
      weekAI: weekAI?.count || 0,
      weekRequests,
    },
    typeDistribution: typeDist.results || [],
    recentLogs: (recentLogs.results || []).map(log => ({
      question: log.question,
      found: !!log.found,
      fromCache: !!log.from_cache,
      channel: log.ai_channel,
      error: log.error,
      time: log.created_at,
    })),
    channels: channels.results || [],
  });
}
