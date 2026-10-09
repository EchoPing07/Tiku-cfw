-- ============================================================
-- 图片性 URL 模式设置（图床链接形态热更，无需发版）
--
-- 背景：title/options 内嵌图片 URL 的提取中，「图片性 URL」的判定除图片后缀外，
-- 还有一组按路径匹配的模式（默认 /ananas/，覆盖超星 latex/editor 等无后缀图床）。
-- 图床 URL 形态会变（尤其超星），算法随版本迭代太慢，放进 settings 表由管理面板
-- 热更（JSON 字符串数组，正则源，如 ["/ananas/", "zhihuishu\\.com/image"]）。
-- 非法值在读取侧逐条跳过并回退默认（见 src/utils/question-images.ts parseImagePatterns），
-- 本迁移仅播种默认值，纯增量、可安全重跑。
-- ============================================================

INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('image_url_patterns', '["/ananas/"]', '图片性 URL 匹配模式（JSON 正则数组；命中即视为图题走视觉模型，默认覆盖超星图床）');
