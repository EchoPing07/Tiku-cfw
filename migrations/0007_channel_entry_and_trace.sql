-- ============================================================
-- 模型条目化：一个模型条目自带一个 API Key（取消多 Key 轮询层）
-- 旧结构：ai_channels(模型) × ai_channel_keys(多 Key)
-- 新结构：ai_channels = base_url + model + 单个 api_key + 权重 + 熔断状态
--   想给同一模型配多个 Key：复制条目、换 Key、设相同权重（层内加权随机分流）
--
-- 同时为 search_logs 增加排障列（状态码/错误类型/尝试链）
--
-- 幂等性说明（CI 每次部署重跑全部迁移）：
--   已执行过的库：第一条 ALTER 报 duplicate column 中断，后续语句不再执行——
--   但 DROP TABLE IF EXISTS 排在 ALTER 之后且 0001 已补丁删表，因此不会出现
--   “CI 重跑 0001 复活 ai_channel_keys 空表”的问题（0001 不再建这张表）。
--   全新库：ai_channel_keys 不存在，回填语句报 no such table 中断，DROP 不会
--   执行（本来无表可删），无副作用。
-- ============================================================

-- 1) ai_channels 条目化：自带 Key 与熔断统计
ALTER TABLE ai_channels ADD COLUMN api_key TEXT;
ALTER TABLE ai_channels ADD COLUMN use_count INTEGER DEFAULT 0;
ALTER TABLE ai_channels ADD COLUMN fail_count INTEGER DEFAULT 0;
ALTER TABLE ai_channels ADD COLUMN last_used TEXT;
ALTER TABLE ai_channels ADD COLUMN disabled_until TEXT;

-- 2) 搜索日志排障列（与调度重构一并落地，避免二次迁移）
ALTER TABLE search_logs ADD COLUMN http_status INTEGER;
ALTER TABLE search_logs ADD COLUMN error_type TEXT;
ALTER TABLE search_logs ADD COLUMN attempts TEXT;

CREATE INDEX IF NOT EXISTS idx_logs_error_type ON search_logs(error_type);

-- 3) 设置：熔断冷却（key_fail_threshold 键名保留，语义改为“达到阈值进入冷却”）
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('channel_cooldown_minutes', '10', '模型熔断后的冷却分钟数（0=仅计数不冷却）');
UPDATE settings SET description = '模型连续失败熔断阈值（达到后进入冷却，冷却期后自动恢复）' WHERE key = 'key_fail_threshold';

-- 4) 回填①：每个模型的第 1 个 Key（最少使用优先，与旧调度顺序一致）上收到条目本身
UPDATE ai_channels SET
    api_key    = (SELECT api_key  FROM ai_channel_keys WHERE channel_id = ai_channels.id ORDER BY use_count ASC, created_at ASC LIMIT 1),
    use_count  = COALESCE((SELECT use_count  FROM ai_channel_keys WHERE channel_id = ai_channels.id ORDER BY use_count ASC, created_at ASC LIMIT 1), 0),
    fail_count = COALESCE((SELECT fail_count FROM ai_channel_keys WHERE channel_id = ai_channels.id ORDER BY use_count ASC, created_at ASC LIMIT 1), 0)
WHERE api_key IS NULL;

-- 5) 回填②：第 2..N 个 Key 拆为独立条目（沿用原模型全部配置与权重，名称追加 Key 备注/掩码）
INSERT INTO ai_channels (id, name, type, base_url, model, weight, temperature, max_tokens, enabled, created_at, api_key, use_count, fail_count)
SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
    c.name || ' · ' || COALESCE(NULLIF(k.name, ''), substr(k.api_key, 1, 6) || '…'),
    c.type, c.base_url, c.model, c.weight, c.temperature, c.max_tokens, c.enabled, c.created_at,
    k.api_key, k.use_count, k.fail_count
FROM ai_channel_keys k
JOIN ai_channels c ON c.id = k.channel_id
WHERE k.id <> (
    SELECT k2.id FROM ai_channel_keys k2
    WHERE k2.channel_id = k.channel_id
    ORDER BY k2.use_count ASC, k2.created_at ASC LIMIT 1
);

-- 6) 删除多 Key 表（0001 已同步补丁，CI 重跑不会复活）
DROP TABLE IF EXISTS ai_channel_keys;
