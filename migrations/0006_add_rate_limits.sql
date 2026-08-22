-- ============================================================
-- 登录防爆破与搜题限流的固定窗口计数表
-- k:            限流对象（如 login:<ip> / search:<api_key_id>）
-- window_start: 整窗起点的 unix 秒（文本），同窗累加、跨窗重置
-- count:        窗口内计数
-- 过期行由每日定时任务清理（见 src/index.ts purgeOldLogs）
-- ============================================================

CREATE TABLE IF NOT EXISTS rate_limits (
    k            TEXT PRIMARY KEY,
    window_start TEXT NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0
);
