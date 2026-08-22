import type { Env } from '../types/env';
import { json, options } from '../utils/response';
import { requireAuth } from '../auth/middleware';
import { getTimezoneOffsetMinutes, tzLabel, tzModifier, localDayStartUTC } from '../utils/timezone';

/** 统计聚合行（今日/本周通用） */
interface UsageAgg {
  total: number | null;
  cached: number | null;
  ai: number | null;
  avg_ms: number | null;
  tokens: number | null;
  prompt: number | null;
  completion: number | null;
}

/** 仪表盘统计 */
export async function dashboardHandler(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return options();

  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  const db = env.DB;

  // 探测 token 列（迁移 0005 未执行时降级为 0，不影响其他统计）
  let hasTokens = true;
  try {
    await db.prepare('SELECT total_tokens FROM search_logs LIMIT 1').first();
  } catch {
    hasTokens = false;
  }
  const tokSum = hasTokens
    ? ', SUM(total_tokens) AS tokens, SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion'
    : ', 0 AS tokens, 0 AS prompt, 0 AS completion';

  // 统计时区（默认北京时间）。今日边界按本地零点折算回 UTC 绑定参数，可走 created_at 索引
  const tzMin = await getTimezoneOffsetMinutes(env);
  const now = new Date();
  const todayStart = localDayStartUTC(now, tzMin);
  const trendStart = localDayStartUTC(now, tzMin, 13);

  const usageAggSQL = `
    SELECT COUNT(*) AS total,
      SUM(from_cache) AS cached,
      SUM(CASE WHEN from_cache = 0 AND found = 1 THEN 1 ELSE 0 END) AS ai,
      AVG(CASE WHEN from_cache = 0 AND found = 1 THEN duration_ms END) AS avg_ms${tokSum}
    FROM search_logs WHERE `;

  const [totalQuestions, todayNew, todayStats, weekStats, typeDist, recentLogs, channelUsage, channelSummary, keySummary, trend, recentErrors] =
    await Promise.all([
      // 题目总数
      db.prepare('SELECT COUNT(*) AS count FROM questions').first<{ count: number }>(),
      // 今日新增题目（本地日零点起）
      db.prepare('SELECT COUNT(*) AS count FROM questions WHERE created_at >= ?').bind(todayStart).first<{ count: number }>(),
      // 今日查询统计（本地日零点起）
      db.prepare(usageAggSQL + 'created_at >= ?').bind(todayStart).first<UsageAgg>(),
      // 近 7 天查询统计（滚动 24h×7，与时区无关）
      db.prepare(usageAggSQL + "created_at >= datetime('now', '-7 days')").first<UsageAgg>(),
      // 题型分布
      db.prepare('SELECT type, COUNT(*) AS count FROM questions GROUP BY type ORDER BY count DESC').all<{ type: string; count: number }>(),
      // 最近搜索记录
      db.prepare(
        `SELECT question, found, from_cache, ai_channel, ai_model, error, created_at${hasTokens ? ', prompt_tokens, completion_tokens, total_tokens' : ''}
         FROM search_logs ORDER BY created_at DESC LIMIT 10`
      ).all(),
      // 近 7 天渠道用量
      db.prepare(
        `SELECT ai_channel AS name, COUNT(*) AS requests, SUM(found) AS success,
           AVG(duration_ms) AS avg_ms${hasTokens ? ', SUM(total_tokens) AS tokens' : ', 0 AS tokens'}
         FROM search_logs
         WHERE created_at >= datetime('now', '-7 days') AND ai_channel IS NOT NULL
         GROUP BY ai_channel ORDER BY requests DESC`
      ).all<{ name: string; requests: number; success: number | null; avg_ms: number | null; tokens: number | null }>(),
      // 渠道数量汇总
      db.prepare('SELECT type, COUNT(*) AS total, SUM(enabled) AS enabled FROM ai_channels GROUP BY type').all<{ type: string; total: number; enabled: number | null }>(),
      // 渠道密钥汇总
      db.prepare('SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM ai_channel_keys').first<{ total: number; enabled: number | null }>(),
      // 近 14 天趋势（按本地日聚合：created_at + 偏移后取日期）
      db.prepare(
        `SELECT date(created_at, ?) AS d, COUNT(*) AS req,
           SUM(CASE WHEN from_cache = 0 AND found = 1 THEN 1 ELSE 0 END) AS ai${hasTokens ? ', SUM(total_tokens) AS tokens' : ', 0 AS tokens'}
         FROM search_logs WHERE created_at >= ?
         GROUP BY d ORDER BY d`
      ).bind(tzModifier(tzMin), trendStart).all<{ d: string; req: number; ai: number | null; tokens: number | null }>(),
      // 近 7 天错误记录
      db.prepare(
        `SELECT question, ai_channel, ai_model, error, created_at
         FROM search_logs
         WHERE (error IS NOT NULL OR found = 0) AND created_at >= datetime('now', '-7 days')
         ORDER BY created_at DESC LIMIT 8`
      ).all<{ question: string; ai_channel: string | null; ai_model: string | null; error: string | null; created_at: string }>(),
    ]);

  const pct = (part: number | null | undefined, whole: number | null | undefined): string =>
    whole ? ((Number(part || 0) / whole) * 100).toFixed(1) + '%' : '0.0%';

  const tok = (v: number | null | undefined) => Number(v || 0);

  return json({
    timezone: { offsetMinutes: tzMin, label: tzLabel(tzMin) },
    stats: {
      // 题库
      totalQuestions: totalQuestions?.count || 0,
      todayNew: todayNew?.count || 0,
      // 查询（今日 / 7 天）
      todayRequests: Number(todayStats?.total || 0),
      todayCached: Number(todayStats?.cached || 0),
      todayAI: Number(todayStats?.ai || 0),
      todayHitRate: pct(todayStats?.cached, todayStats?.total),
      weekRequests: Number(weekStats?.total || 0),
      weekCached: Number(weekStats?.cached || 0),
      weekAI: Number(weekStats?.ai || 0),
      hitRate: pct(weekStats?.cached, weekStats?.total),
      // AI 消耗
      todayTokens: { prompt: tok(todayStats?.prompt), completion: tok(todayStats?.completion), total: tok(todayStats?.tokens) },
      weekTokens: { prompt: tok(weekStats?.prompt), completion: tok(weekStats?.completion), total: tok(weekStats?.tokens) },
      avgAiLatencyMs: Math.round(Number(weekStats?.avg_ms || 0)),
      avgTokensPerAI: weekStats?.ai ? Math.round(tok(weekStats?.tokens) / Number(weekStats.ai)) : 0,
      tokensAvailable: hasTokens,
    },
    trend: trend.results || [],
    typeDistribution: typeDist.results || [],
    channelUsage: (channelUsage.results || []).map(c => ({
      name: c.name,
      requests: c.requests,
      success: Number(c.success || 0),
      avgMs: Math.round(Number(c.avg_ms || 0)),
      tokens: tok(c.tokens),
    })),
    channelSummary: {
      channels: channelSummary.results || [],
      keys: { total: Number(keySummary?.total || 0), enabled: Number(keySummary?.enabled || 0) },
    },
    recentLogs: (recentLogs.results || []).map((log: Record<string, unknown>) => ({
      question: log.question,
      found: !!log.found,
      fromCache: !!log.from_cache,
      channel: log.ai_channel,
      model: log.ai_model,
      error: log.error,
      time: log.created_at,
      tokens: hasTokens ? tok(log.total_tokens as number | null) : null,
    })),
    recentErrors: recentErrors.results || [],
  });
}
