-- ============================================================
-- AI 搜题默认参数调整
--
-- 内容：
--   1) ai_channels 新增 extra_params 列（条目级附加请求参数，JSON 对象字符串；
--      典型用途：混合推理模型显式关闭思考，如 {"enable_thinking": false}）
--   2) 新设置 vision_timeout：视觉模型单次请求超时（默认 60s；文本模型沿用 ai_timeout）
--   3) 默认值回填：temperature 0.3 → 0.7、max_tokens 2000 → 4096
--      仅更新仍等于旧默认值的行——用户自定义过其他值的条目不动
--
-- 幂等性说明（部署时重跑全部迁移）：
--   已执行过的库：首条 ALTER 报 duplicate column 中断，后续语句（含回填 UPDATE）不再执行，
--   回填因此只生效一次；用户迁移后手动改回 0.3/2000 的条目不会被重跑覆盖。
--   全新库：0001 建表时已含 extra_params 列，首条 ALTER 同样失败中断，vision_timeout
--   与新默认值由 0002_seed.sql 直接写入（种子已同步更新）。
--
--   ⚠ 依赖 wrangler d1 execute 「首错即中止整个文件」的语义（已实测验证）。
--   不要用 sqlite3 CLI 等遇错继续执行的工具跑本文件——重跑会把用户手动改回
--   旧默认值的行再次回填。项目全部迁移脚本（package.json db:*）均走 wrangler。
-- ============================================================

-- 1) 条目级附加请求参数
ALTER TABLE ai_channels ADD COLUMN extra_params TEXT;

-- 2) 视觉模型独立超时（图题含图片推理，天然更慢）
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('vision_timeout', '60', '视觉模型单次请求超时秒数（默认 60；文本模型用 ai_timeout）');
UPDATE settings SET description = 'AI 请求超时秒数（文本模型；视觉模型用 vision_timeout）' WHERE key = 'ai_timeout';

-- 3) 默认值回填：仅动仍等于旧默认的行
UPDATE ai_channels SET temperature = 0.7 WHERE temperature = 0.3;
UPDATE ai_channels SET max_tokens = 4096 WHERE max_tokens = 2000;
