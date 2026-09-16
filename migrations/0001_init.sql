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

-- ============ AI 渠道表（模型条目：一个条目 = 端点 + 模型 + 单个 API Key + 权重）============
-- 想给同一模型配多个 Key：复制条目、换 Key、设相同权重（加权随机分流）
CREATE TABLE IF NOT EXISTS ai_channels (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL,               -- text 文本 / vision 视觉
    base_url      TEXT NOT NULL,
    model         TEXT NOT NULL,
    api_key       TEXT,                        -- 条目自带单 Key
    weight        INTEGER DEFAULT 1,           -- 加权随机的权重（越高被选中概率越大）
    temperature   REAL DEFAULT 0.3,
    max_tokens    INTEGER DEFAULT 2000,
    enabled       INTEGER DEFAULT 1,
    use_count     INTEGER DEFAULT 0,
    fail_count    INTEGER DEFAULT 0,
    last_used     TEXT,
    disabled_until TEXT,                       -- 熔断冷却截止时刻（NULL/过期 = 可参与调度）
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
);

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
    ai_request    TEXT,                        -- AI 请求信封（v1 格式，见 src/ai/debug-envelope.ts）
    ai_response   TEXT,                        -- AI 响应信封
    prompt_tokens     INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens      INTEGER DEFAULT 0,
    http_status   INTEGER,                     -- AI 上游响应状态码（网络错误为 NULL）
    error_type    TEXT,                        -- 错误分类（timeout/http_auth/bad_json/bad_input 等）
    attempts      TEXT,                        -- 尝试链 JSON（每次调度的模型/Key/状态/耗时）
    created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_created ON search_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_found ON search_logs(found);
CREATE INDEX IF NOT EXISTS idx_logs_hash ON search_logs(question_hash);
CREATE INDEX IF NOT EXISTS idx_logs_day ON search_logs(date(created_at));
CREATE INDEX IF NOT EXISTS idx_logs_error_type ON search_logs(error_type);
