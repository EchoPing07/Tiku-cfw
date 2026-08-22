-- ============================================================
-- 搜索日志增加 AI Token 用量字段，用于仪表盘 AI 消耗统计
-- prompt_tokens:     输入 token 数
-- completion_tokens: 输出 token 数
-- total_tokens:      合计 token 数（缓存命中记 0）
-- ============================================================

ALTER TABLE search_logs ADD COLUMN prompt_tokens INTEGER DEFAULT 0;
ALTER TABLE search_logs ADD COLUMN completion_tokens INTEGER DEFAULT 0;
ALTER TABLE search_logs ADD COLUMN total_tokens INTEGER DEFAULT 0;

-- 按天聚合趋势查询的辅助索引
CREATE INDEX IF NOT EXISTS idx_logs_day ON search_logs(date(created_at));
