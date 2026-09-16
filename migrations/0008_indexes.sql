-- ============================================================
-- 索引补齐（永远幂等，可安全重复执行）
--
-- 为什么需要这个文件：
-- - 旧库升级：error_type 列由 0007 加出，索引在 0007 中已建（此处双保险）
-- - 全新安装：0001 直接建出全列表结构后，0005/0007 的首条 ALTER 报
--   duplicate column 中断，其文件内的 CREATE INDEX 语句不会执行，
--   导致全新库缺 idx_logs_day / idx_logs_error_type —— 由本文件补齐
-- - 本文件只含 CREATE INDEX IF NOT EXISTS，任何已迁移状态重跑都安全
-- ============================================================

-- 按天聚合趋势查询的辅助索引（仪表盘 14 天趋势）
CREATE INDEX IF NOT EXISTS idx_logs_day ON search_logs(date(created_at));

-- 错误类型筛选的辅助索引（日志页 error_type 筛选）
CREATE INDEX IF NOT EXISTS idx_logs_error_type ON search_logs(error_type);