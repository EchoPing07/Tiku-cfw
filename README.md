# Tiku-cfw

> 基于 Cloudflare Worker 的 AI 题库服务，兼容 [OCS 网课助手](https://docs.ocsjs.com) AnswererWrapper 规范。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

## 简介

Tiku-cfw 是一个部署在 Cloudflare Workers 上的 AI 题库服务。它接收来自 OCS 网课助手脚本的搜题请求，先查询本地缓存（D1 数据库），未命中时调用 AI 大模型生成答案并自动缓存，避免重复消耗 Token。

### 核心特性

- 🔍 **OCS 兼容** — 搜题接口完全兼容 OCS `AnswererWrapper` 规范，配置即用
- 🤖 **多模型调度** — 支持文本/视觉两类模型，多模型权重调度，最少使用优先轮询，失败自动禁用降级，支持一键测试连通（成功自动恢复 API Key）
- 💾 **智能缓存** — 题目归一化后精确匹配，命中缓存秒回，永不过期
- 🖼️ **图片支持** — 带图题目自动路由到视觉模型
- 📊 **Web 管理面板** — 仪表盘（题库查询 + Token 用量双分区、14 天趋势图）、题库管理、在线搜题、题库密钥管理、模型列表配置、搜索日志（含 Token 用量与答案纠错）
- 🌓 **明暗主题** — 跟随系统或手动切换
- 🚀 **零成本部署** — Cloudflare Workers 免费额度 + D1 免费额度 + GitHub Actions 自动部署

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Cloudflare Workers |
| 数据库 | Cloudflare D1 (SQLite) |
| AI | OpenAI 兼容接口 |
| 语言 | TypeScript |
| 前端 | Tailwind CSS + 原生 JS SPA |
| 部署 | GitHub Actions → Cloudflare Workers |

## 部署

### 方式一：GitHub 自动部署（推荐）

全程在浏览器中操作，无需安装任何命令行工具。

#### 1. Fork / 使用此模板

点击 GitHub 仓库的 **Use this template** 或 **Fork** 创建自己的仓库。

#### 2. 创建 D1 数据库

登录 [Cloudflare 控制台](https://dash.cloudflare.com/) → **Workers & Pages** → **D1** → **Create database**，名称填 `tiku-cfw-db`，创建后复制 **Database ID**。

#### 3. 创建 API Token

访问 [API Tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** → 选择 **Edit Cloudflare Workers** 模板 → 权限中添加 **D1** → **Edit** → 创建后复制。

#### 4. 获取 Account ID

在 Cloudflare 控制台首页右侧栏可以看到 **Account ID**。

#### 5. 设置 GitHub Secrets

在仓库 **Settings** → **Secrets and variables** → **Actions** → **New repository secret**：

| Secret 名称 | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 步骤 3 的 Token |
| `CLOUDFLARE_ACCOUNT_ID` | 步骤 4 的 Account ID |
| `D1_DATABASE_ID` | 步骤 2 的 Database ID |

#### 6. 运行数据库迁移

在仓库 **Actions** 标签页 → 选择 **Migrate** → **Run workflow** → 等待执行完成。

#### 7. 部署

推送代码到 `main` 分支，**Deploy** workflow 自动触发。也可以在 **Actions** → **Deploy** → **Run workflow** 手动触发。

#### 8. 设置生产密钥（可选但建议）

在 Cloudflare 控制台 → Worker 详情 → **Settings** → **Variables and Secrets**：

| 变量名 | 类型 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | Secret | 管理面板登录密码 |
| `JWT_SECRET` | Secret | JWT 签名密钥（随机字符串） |

不设置则使用默认值（`password` / `change-me-in-production`）。

#### 9. 访问

部署成功后访问 `https://tiku-cfw.<your-subdomain>.workers.dev`，用密码登录管理面板。

---

### 方式二：命令行部署

```bash
git clone https://github.com/EchoPing07/Tiku-cfw.git
cd Tiku-cfw
npm install
npx wrangler login

# 创建 D1 数据库，将返回的 database_id 填入 wrangler.toml
npx wrangler d1 create tiku-cfw-db

# 建表
npx wrangler d1 execute tiku-cfw-db --remote --file=migrations/0001_init.sql
npx wrangler d1 execute tiku-cfw-db --remote --file=migrations/0002_seed.sql

# 部署
npx wrangler deploy

# 设置密钥
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put JWT_SECRET
```

---

### 本地开发

```bash
npm install
npm run db:migrate:local   # 本地建表
npm run db:seed:local      # 写入初始数据
npm run db:migrate:share:local  # 密钥分享功能（0004，可选）
npm run db:migrate:token:local  # Token 用量统计（0005，可选，不执行则仪表盘 Token 显示为 0）
npm run db:migrate:rate:local   # 登录/搜题限流（0006，可选，不执行则限流不生效）
npm run dev                 # 启动开发服务器 → http://localhost:8787

npm test                    # 单元测试
npm run typecheck           # 类型检查
```

默认密码 `password`。

### 密钥分享链接

管理面板「题库密钥」页面可为每个密钥单独开启「分享 OCS 配置」开关，开启后生成免登录链接（`/share.html?token=...`），打开即可查看并复制完整的 OCS 配置。关闭开关或密钥被禁用/过期后链接立即失效。注意：配置中包含题库密钥，请勿将链接转发给他人。

---

## 安全须知

- **密钥明文存储**：题库密钥与各 AI 渠道的 API Key 以明文保存在 D1 数据库中，管理面板可直接查看。拿到 D1 访问权即拿到全部密钥，请勿将 D1 凭据泄露给他人；建议为 AI 渠道使用可设置消费上限、可随时作废的独立 Key，并定期轮换。
- **分享链接即密钥**：开启「分享 OCS 配置」后，链接内含题库密钥，任何拿到链接的人都能消耗你的 AI 额度。仅在必要时开启，用完及时关闭（关闭后链接立即失效）。
- **接口限流**：登录接口按 IP 限流（5 分钟 10 次尝试）；搜题接口按密钥限流（默认每分钟 120 次，可在「系统设置 → 搜题限流」调整，0 = 不限流）。持续收到 429 请检查客户端是否异常重试。限流依赖迁移 0006，未执行时自动放行。
- 生产环境务必通过 Cloudflare 控制台或 `wrangler secret put` 设置 `ADMIN_PASSWORD` 与 `JWT_SECRET`，不要使用默认值。

---

## 使用指南

### 1. 配置模型

在管理面板「模型列表」页面：
1. 添加模型（填写 API 地址、模型 ID、类型 text/vision、权重）
2. 在模型下添加 API Key（支持多 Key 轮询）
3. 启用模型

### 2. 创建题库密钥

在管理面板「题库密钥」页面创建密钥 → 点击「复制 OCS 配置」→ 获得完整的 OCS 题库配置 JSON。

### 3. OCS 对接

将复制的 JSON 粘贴到 OCS 脚本的题库配置中即可。OCS 会自动调用你的 Worker 搜题。

---

## API 参考

### 搜题接口

```
POST /api/search
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "title": "题目内容",
  "type": "single",            // 可选: single/multiple/judgement/completion
  "options": "A. xxx\nB. xxx", // 可选
  "images": ["https://..."]     // 可选，有图走视觉模型
}
```

### 管理面板 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/login` | 登录 |
| GET | `/api/admin/dashboard` | 仪表盘 |
| GET/POST | `/api/admin/questions` | 题目列表/创建 |
| PUT/DELETE | `/api/admin/questions/:id` | 编辑/删除 |
| GET | `/api/admin/questions/by-hash/:hash` | 按归一化哈希查题目（日志纠错用） |
| POST | `/api/admin/questions/import` | 批量导入 |
| GET | `/api/admin/questions/export` | 导出 |
| GET/POST | `/api/admin/keys` | 题库密钥管理 |
| PUT/DELETE | `/api/admin/keys/:id` | 编辑/删除 |
| GET | `/api/admin/keys/:id/ocs-config` | 获取 OCS 配置（管理面板复制用） |
| GET | `/api/share/ocs/:token` | 免登录查看 OCS 配置（分享开关开启后有效） |
| GET/POST | `/api/admin/channels` | 模型管理 |
| PUT/DELETE | `/api/admin/channels/:id` | 编辑/删除模型 |
| POST | `/api/admin/channels/:id/test` | 测试模型连通性（逐 API Key，成功自动恢复） |
| GET/POST | `/api/admin/channels/:id/keys` | 模型 API Key 管理 |
| PUT/DELETE | `/api/admin/channel-keys/:id` | 编辑/删除 API Key |
| POST | `/api/admin/channel-keys/:id/reset` | 重置失败计数 |
| POST | `/api/admin/debug/search` | 在线搜题（管理面板，走完整生产链路） |
| GET/PUT | `/api/admin/settings` | 系统设置 |
| GET/DELETE | `/api/admin/logs` | 搜索日志 |
| GET | `/api/health` | 健康检查 |

完整接口规范参考 [OCS-API-参考文档.md](../OCS-API-参考文档.md)。

---

## 项目结构

```
Tiku-cfw/
├── .github/workflows/
│   ├── deploy.yml              # 推送 main 自动部署
│   └── migrate.yml             # 手动触发数据库迁移
├── src/
│   ├── index.ts                # Worker 入口，路由分发
│   ├── api/                    # 搜题接口（OCS + 调试共用核心）+ 健康检查
│   ├── admin/                  # 管理后台 API（8 个模块，含在线搜题）
│   ├── ai/                     # 多模型调度器（含 Token 用量采集）
│   ├── cache/                  # 题目归一化 + 哈希
│   ├── auth/                   # JWT + API Key 认证
│   ├── types/                  # 类型定义
│   ├── utils/                  # 工具函数
│   └── web/index.html          # Web 管理面板 SPA
├── migrations/                 # D1 数据库迁移 SQL
├── wrangler.toml               # Cloudflare 配置
├── package.json
└── LICENSE
```

## License

[MIT](LICENSE) © 2026 EchoPing
