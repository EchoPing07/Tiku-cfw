-- ============================================================
-- 思考等级列 + 纯文本题路由设置
--
-- 内容：
--   1) ai_channels 新增 thinking_level 列（条目级思考等级：off/low/medium/high；
--      NULL = 不附加，跟随厂商默认）。调度时按模型 ID 自动映射为厂商参数：
--      qwen* → {"enable_thinking": bool}、GLM/豆包 → {"thinking": {"type": ...}}、
--      其余（o 系/gpt-5/Gemini 等）→ {"reasoning_effort": ...}，见 src/ai/thinking.ts
--   2) 新设置 text_exclude_vision：纯文本题是否绕过视觉条目（默认 0 = 全量条目参与；
--      带图题始终仅调度支持视觉的条目）
--
-- 幂等性说明（部署时重跑全部迁移）：
--   已执行过的库：首条 ALTER 报 duplicate column 中断，后续语句不再执行；
--   全新库：0001 建表时已含 thinking_level 列，首条 ALTER 同样失败中断，
--   text_exclude_vision 由 0002_seed.sql 直接写入（种子已同步更新）。
--
--   ⚠ 依赖 wrangler d1 execute 「首错即中止整个文件」的语义（已实测验证）。
--   不要用 sqlite3 CLI 等遇错继续执行的工具跑本文件。
-- ============================================================

-- 1) 条目级思考等级
ALTER TABLE ai_channels ADD COLUMN thinking_level TEXT;

-- 2) 纯文本题是否绕过视觉条目（带图题始终仅视觉条目）
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('text_exclude_vision', '0', '纯文本题是否绕过视觉条目（1=仅纯文本模型；0=全量模型，默认）');
