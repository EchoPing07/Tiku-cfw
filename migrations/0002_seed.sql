-- ============================================================
-- Tiku-cfw 初始数据
-- ============================================================

-- 默认系统设置
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('site_name',           'Tiku-cfw',  '站点名称'),
    ('log_retention_days',  '30',        '日志保留天数（0=永久）'),
    ('ai_timeout',          '30',        'AI 请求超时秒数'),
    ('key_fail_threshold',  '3',         'Key 连续失败禁用阈值'),
    ('cors_origins',        '*',         'CORS 允许的域名'),
    ('system_prompt',       '',          '自定义系统提示词（空=用默认）'),
    ('timezone_offset',     '480',       '统计时区偏移分钟数（480=北京时间 UTC+8）'),
    ('search_rate_limit',   '120',       '搜题限流：每分钟每密钥最大次数（0=不限）');

-- 默认 AI 渠道示例（用户需在面板中填写 API Key）。
-- 仅在 ai_channels 为空时写入（首次建库）：用户删除默认渠道后不会被本迁移复活，
-- 需要时请在面板手动重建。
INSERT OR IGNORE INTO ai_channels (id, name, type, base_url, model, weight, temperature, max_tokens, enabled)
SELECT column1, column2, column3, column4, column5, column6, column7, column8, column9 FROM (VALUES
    ('default-text',   'OpenAI 文本', 'text',   'https://api.openai.com/v1', 'gpt-4o-mini', 1, 0.3, 2000, 0),
    ('default-vision', 'OpenAI 视觉', 'vision', 'https://api.openai.com/v1', 'gpt-4o',      1, 0.3, 2000, 0)
) WHERE NOT EXISTS (SELECT 1 FROM ai_channels);
