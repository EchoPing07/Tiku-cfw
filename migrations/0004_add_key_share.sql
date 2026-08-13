-- ============================================================
-- API 密钥增加 OCS 配置分享开关与分享令牌
-- share_enabled: 1=允许免登录通过分享链接查看 OCS 配置
-- share_token:   分享链接令牌（sh_ 开头随机串），关闭分享时置空使链接失效
-- ============================================================

ALTER TABLE api_keys ADD COLUMN share_enabled INTEGER DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN share_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_share_token ON api_keys(share_token) WHERE share_token IS NOT NULL;
