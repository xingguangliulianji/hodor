# hodor

Telegram Forum Topics 客服消息中继 Bot —— 一个用户，一个话题，消息不串线。
设计、部署与运维文档见 [docs/](docs/)（VitePress 站点，`npm run docs:dev` 本地预览）。

**当前进度**：阶段 1–5 已交付并真机验收——webhook 绑定与鉴权、幂等与失败重推、用户建档与 topic 双向映射、文本 + 7 类媒体双向直传、欢迎语（`WELCOME_TEXT` 可配置）与用户信息置顶、双向消息账本、数学题人机验证与未验证拦截、分钟限频与超限重验、提示频控、`/help` `/ban` `/unban` 基础管理命令、验证开关与纯按钮模式（`/verifyon` `/verifyoff` `/verifymode`）、验证有效期（`VERIFY_TTL_HOURS`）、备注与高危标记（`/note` `/risk`）、429 有界重试。阶段 6 会话维护已交付并真机验收——`/archive` 软归档（保留历史/备注、回访重验重开）、`/deluser` 物理删除（二次确认，删 Telegram 话题 + Hodor 数据）、`/purgemsg` 话题消息清理、`/wipealldata`（先删全部群内话题再清库，保留 settings）、Telegram 原生话题关闭/重开状态同步与删除自愈。删除类命令不覆盖 Telegram 私聊窗口历史。阶段 7 公开发布支持的代码与测试面已交付——完整自检端点 `GET /selfcheck`（环境变量 / 七张表 / webhook 指向逐项检查：全过 200，有未通过项 503 + `failed` 数组逐条给出中文失败原因，`/health` 保持纯存活探针）、运维 SQL 查询包 `scripts/d1-console.sql`（总览 / 用户 / topic / 消息账本 / 失败 update / 孤儿检测 + 危险区维护语句）、发布回归测试套件（`test/release-regression.test.ts`，9 个部署链路顺序场景）；fork 从零部署与已有实例升级的真机验收按任务验收清单执行。后续按 [docs/todo](docs/todo/index.md) 的阶段计划推进（阶段 7 真机验收通过后发布完整 v1）。开发过程由 [Trellis](.trellis/workflow.md) 管理。

## 准备工作（一次性）

完整前置清单见 [docs/guide/deploy.md](docs/guide/deploy.md)。

**Telegram 侧**

1. @BotFather `/newbot` 建 Bot，保存 Token（`TELEGRAM_BOT_TOKEN`）；`/setprivacy` → Disable（防御性冗余）
2. 建一个**私有** Supergroup（不设公开用户名），在群设置里开启 **Topics**；**不开** protected content（限制保存内容会影响后续媒体中继，T22 实测项）
3. 把 Bot 拉进群并授予：Manage Topics / Send Messages / Delete Messages / Pin Messages
4. 绑定 Webhook 之前先取 ID：往群里随便发一条消息，浏览器打开
   `https://api.telegram.org/bot<TOKEN>/getUpdates`，从返回里记下群 `chat_id`（`-100` 开头负数）和你自己的 `user_id`

**Cloudflare 侧**

5. 登录：`npx wrangler login`
6. 建库不需要手动做——首次部署时 postinstall 钩子会按名字自动创建/复用 D1 并完成绑定（见下方部署章节）

**环境变量**

7. 部署后在面板 Worker → 设置 → 变量和机密 配置 5 条必填项（部署向导 / Deploy 按钮不再代收变量——表单零提示，统一部署后面板配置；模板与说明见 `.dev.vars.example`，一次即可，`keep_vars: true` 已保证跨部署持久）；本地调试可选：`cp .dev.vars.example .dev.vars` 后 `npx wrangler dev`

## 环境变量说明（模板与注释见 `.dev.vars.example`）

| 变量 | 必填 | 用途 | 敏感 | 缺省 |
|------|------|------|------|------|
| `TELEGRAM_BOT_TOKEN` | 必填 | Bot Token（BotFather 发放），所有 Bot API 调用的凭证 | 是 | — |
| `TELEGRAM_WEBHOOK_SECRET` | 必填 | Telegram 回调头鉴权（SHA-256 比对）；三个 Secret 必须互异 | 是 | — |
| `ADMIN_SECRET` | 必填 | 管理端点路径段凭证（`/setwebhook/<ADMIN_SECRET>` 等，浏览器直接访问） | 是 | — |
| `SUPPORT_CHAT_ID` | 必填 | 私有支持群 chat_id（`-100` 开头），Topic 所在群与双向路由依据 | 否 | — |
| `ADMIN_IDS` | 必填 | 管理员 user_id 白名单，逗号分隔 | 否 | — |
| `MAX_MESSAGES_PER_MINUTE` | 选填 | 每用户每分钟转发上限，超限触发重验（阶段 4 生效） | 否 | `20` |
| `VERIFY_TTL_HOURS` | 选填 | 验证有效期小时数，0=永久（阶段 5 生效） | 否 | `0` |
| `MAX_ATTEMPTS` | 选填 | 同一 update 处理失败重试上限，超限标记 failed 跳过 | 否 | `3` |
| `WELCOME_TEXT` | 选填 | 自定义欢迎语（字面 `\n` 解释为换行） | 否 | 内置默认文案 |

注入方式（⚠️ 2026-09-28 实测与官方文档核实）：`wrangler deploy` 默认按配置重置绑定，但本仓库已设 **`keep_vars: true`**——面板「变量和机密」配置的变量（Text 或机密均可）**跨部署持久**；官方文档另明确 **Secrets 永不因部署删除**。

- **全部 9 个**：5 条必填先配（当前阶段即用），4 条选填按需；3 个 Secret 建议用「机密」类型
- **本地调试（可选）**：`cp .dev.vars.example .dev.vars` 后逐行取消注释并填值（必填 5 条必须启用），再 `npx wrangler dev`（`.dev.vars` 已被 git 忽略），与面板互不影响
- 也可用 `npx wrangler secret put <NAME>`（Secret 类型，等价持久）

## 开发流程

```bash
npm install
npm test            # vitest：workerd 沙箱 + 每文件隔离的本地 D1
npm run typecheck
```

完整指南（一次性准备、手动运行 Worker、命令速查与注意事项）见 [docs/guide/development.md](docs/guide/development.md)。

## 部署到 Cloudflare（自动部署 · Workers Builds）

三条路径共用同一套声明式配置（`wrangler.jsonc` + `.dev.vars.example`）。本项目面向自部署：**第三方使用者推荐「fork 后部署」**，每份部署独享自己的 D1 与变量。

### 路径一（推荐）：fork 后部署（零仓库改动，全程浏览器）

第三方使用者：

1. Fork `huaiminyetnotsleep/hodor` 到自己的 GitHub 账号
2. Cloudflare 面板 → **Workers & Pages → Create → Workers → Import a repository** → 授权 Cloudflare GitHub App → 选中**你的 fork**，向导逐项配置：
   - 项目名称：`hodor`
   - 变量表单：**不出现**（`.dev.vars.example` 条目全部注释 = 零提示，见该文件头部说明）；所有变量统一部署后在面板「设置 → 变量和机密」配置（见第 3 步 `/selfcheck` 指引），`keep_vars: true` 已在仓库配置，配好的值**跨部署持久，fork 使用者零代码改动**
   - 构建命令：**留空**；部署命令：**保持向导默认 `npx wrangler deploy`，无需改动**——置备（创建/复用同名 D1 → 注入 database_id 到构建工作区，**不改动你的仓库** → 幂等迁移）由 `npm install` 的 postinstall 钩子自动完成，先于部署执行
   - 关闭「启用预览构建」（Phase 1 无 preview 分支部署需求）
3. 部署 → 验证：`curl https://hodor.<你的子域>.workers.dev/health` → `{"status":"ok","version":"…"}`；再 `curl https://hodor.<你的子域>.workers.dev/selfcheck` 做完整自检——刚部署、变量未配时预期 503 与 `failed` 数组（逐条点名缺失的 5 条必填变量，不回显任何密钥值），据此到面板 Worker → 设置 → 变量和机密 补齐（3 个 Secret 用机密类型，`SUPPORT_CHAT_ID` / `ADMIN_IDS` 用文本；4 条选填按需、均有默认值）；然后访问 `/setwebhook/<ADMIN_SECRET>` 完成绑定，再开一次 `/selfcheck` 应全绿返回 200，即可真机聊天
4. 此后 **push 你的 fork 即自动构建部署**；上游更新 → fork 页点 **Sync fork** → 自动部署

> 排错：报 `The database … could not be found (7404 / 10181)` = 自动置备未生效——先查构建日志**安装阶段**的 `[provision]` 输出；兜底：把部署命令改为 `npm run deploy`（显式置备后部署）再重建。
> 部署后变量丢失：确认部署所用代码包含 `keep_vars: true`（本仓库已配置，wrangler.jsonc）；仍丢失时检查变量是否加在了别的 Worker 上。
> 若构建令牌无建库权限：在面板建好同名 D1 再重跑，脚本会按名字复用，仍零仓库改动。
>
> 仓库所有者本人部署：无需 fork，Import a repository 直接选现有仓库，其余相同。

### 路径二：GitHub URL 一键部署（Deploy 按钮）

适合没有任何现成仓库的全新使用方——点按钮，Cloudflare 会在你的 GitHub 账号下**自动创建仓库副本**（相当于自动 fork）并完成置备连接：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/huaiminyetnotsleep/hodor)

实测注意（2026-09-28）：

- 副本仓库名默认取项目名——你的账号下已有同名仓库会报「已存在具有该名称的存储库」（仓库所有者部署请走路径一直接导入现有仓库）
- 报「无法获取存储库内容」多为瞬时失败：确认 URL 为标准 HTTPS 地址（非 `git@…` SSH 形式）、仓库 Public，稍后重试或改走路径一
- 其余置备项（D1 / 部署命令）与路径一相同；表单零变量提示，变量与路径一相同，部署后面板配置（见路径一第 3 步）；`.dev.vars.example` 是本地开发模板（其表单清单用途现为零提示设计）

### 路径三：手工 wrangler（不依赖 GitHub，救急/本地验证用）

```bash
npx wrangler login
npm run deploy          # = node scripts/deploy.mjs：自动建/复用 D1、注入 id、迁移、部署
curl https://hodor.<你的子域>.workers.dev/health
```

仅注入/更新变量时：`npx wrangler secret put <NAME>`（变量清单见 `.dev.vars.example`）。

### 与业界做法的对照

「零配置部署 + 数据库置备」在业界有三种成熟模式，本项目各取所长：

| 模式 | 业界代表 | hodor 的对应 |
|---|---|---|
| **配置即资源**（IaC in repo）：平台按声明置备并回写 | Render `render.yaml`、CF 模板向导/按钮 | wrangler.jsonc 即声明式资源描述；路径二（按钮）由平台置备 D1 |
| **置备/迁移是部署管线的独立阶段** | Heroku release phase、Render `preDeployCommand`、Fly `release_command` | `scripts/deploy.mjs`：云端经 postinstall 钩子（`WORKERS_CI=1` 门控）自动执行，本地 `npm run deploy` 显式执行，均先于部署 |
| **平台侧建库 + env 注入引用**（连接信息不进仓库） | Vercel Marketplace、Heroku Add-ons（`DATABASE_URL` 模式） | 9 个变量全部走面板「变量和机密」/ Secret（部署表单零提示）；D1 是同平台 binding（真实 id 不进仓库，构建时按名字解析注入），故用前两种模式 |

业界同样没有的第四种——让用户手改配置文件里的资源 ID——正是本方案要消除的。

## 部署后的更新与回滚（三条路径通用）

- 源码更新走 push 自动部署（路径三则手工 deploy）；**不再点按钮 / 不再重复导入**
- 回滚：Dashboard → Deployments 一键回退（秒级）或 `npx wrangler rollback`；**Worker 回滚不回滚 D1**，迁移始终 append-only
- 默认全量生效；需要灰度时用 Dashboard → Deployments → 版本上线控制（Versions gradual deployments，如 1% → 10% → 50% → 100%），任一阶段异常立即回退 Worker 版本
- Webhook URL、Secrets、D1 资源跨更新原样保留（发布不重设 Webhook）
- 人工验证：部署后 `/health` 确认链路，`/setwebhook/<ADMIN_SECRET>` 绑定后即可真机聊天验收

## 运维

- 管理端操作（绑定 / 解绑 webhook）通过浏览器访问 `/setwebhook/<ADMIN_SECRET>`、`/deletewebhook/<ADMIN_SECRET>`；运维查询见下

### 数据库巡检（Dashboard D1 Console）

**唯一查询途径**：Dashboard → Storage & Databases → D1 → `hodor` → Console，直接输入 SQL 执行。常用查询（用户 / topic / 幂等状态 / 失败 update）见 [docs/guide/ops.md](docs/guide/ops.md) 常用 SQL 一节，在 Console 直接粘贴执行。

只读约定：Console 只做只读查询；用户消息正文属敏感数据，直查结果不外发、不贴日志。
