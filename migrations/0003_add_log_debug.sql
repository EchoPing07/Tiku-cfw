-- ============================================================
-- 搜索日志增加 AI 请求/响应原始内容字段，方便排查问题
-- ============================================================

ALTER TABLE search_logs ADD COLUMN ai_request TEXT;
ALTER TABLE search_logs ADD COLUMN ai_response TEXT;
