-- ============================================================
-- Tiku-cfw 数据库初始化迁移
-- ============================================================

-- ============ 题目缓存表 ============
CREATE TABLE IF NOT EXISTS questions (
    id            TEXT PRIMARY KEY,
    question      TEXT NOT NULL,
    question_norm TEXT NOT NULL,
    question_hash TEXT NOT NULL UNIQUE,
    answer        TEXT NOT NULL,
    type          TEXT,
    options       TEXT,
    source        TEXT DEFAULT 'ai',
    ai_model      TEXT,
    has_images    INTEGER DEFAULT 0,
    hit_count     INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_question_hash ON questions(question_hash);
CREATE INDEX IF NOT EXISTS idx_type ON questions(type);
CREATE INDEX IF NOT EXISTS idx_created_at ON questions(created_at);

-- ============ API 密钥表（明文存储，可查看）============
CREATE TABLE IF NOT EXISTS api_keys (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL DEFAULT '',
    enabled     INTEGER DEFAULT 1,
    expires_at  TEXT,
    use_count   INTEGER DEFAULT 0,
    last_used   TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
);

-- ============ AI 渠道表 ============
CREATE TABLE IF NOT EXISTS ai_channels (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    base_url    TEXT NOT NULL,
    model       TEXT NOT NULL,
    weight      INTEGER DEFAULT 1,
    temperature REAL DEFAULT 0.3,
    max_tokens  INTEGER DEFAULT 2000,
    enabled     INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
);

-- ============ AI 渠道密钥表（明文存储，可查看）============
CREATE TABLE IF NOT EXISTS ai_channel_keys (
    id          TEXT PRIMARY KEY,
    channel_id  TEXT NOT NULL,
    api_key     TEXT NOT NULL,
    name        TEXT DEFAULT '',
    enabled     INTEGER DEFAULT 1,
    use_count   INTEGER DEFAULT 0,
    fail_count  INTEGER DEFAULT 0,
    last_used   TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (channel_id) REFERENCES ai_channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_channel_keys_channel ON ai_channel_keys(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_keys_enabled ON ai_channel_keys(channel_id, enabled);

-- ============ 系统设置表 ============
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    description TEXT,
    updated_at  TEXT DEFAULT (datetime('now'))
);

-- ============ 搜索日志表 ============
CREATE TABLE IF NOT EXISTS search_logs (
    id            TEXT PRIMARY KEY,
    question      TEXT NOT NULL,
    question_hash TEXT NOT NULL,
    found         INTEGER DEFAULT 0,
    from_cache    INTEGER DEFAULT 0,
    answer        TEXT,
    ai_channel    TEXT,
    ai_model      TEXT,
    duration_ms   INTEGER DEFAULT 0,
    api_key_id    TEXT,
    error         TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_created ON search_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_found ON search_logs(found);
CREATE INDEX IF NOT EXISTS idx_logs_hash ON search_logs(question_hash);
