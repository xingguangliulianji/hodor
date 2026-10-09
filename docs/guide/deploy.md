# 部署流程

## 准备工作

1. **申请 bot**：Telegram 中找 [@BotFather](https://t.me/BotFather) → `/newbot`，按提示完成后记下 bot token
2. **创建超级群组**：新建群组 → 群设置中开启「话题」（Topics）功能
3. **获取群 chat_id**（`-100` 开头），三种方式任选：
   - 邀请 [@sc_ui_bot](https://t.me/sc_ui_bot) 进群，发送 `/id`
   - 使用 [@getidsbot](https://t.me/getidsbot) 获取
   - 让 bot 进群后发一条消息，浏览器打开 `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`，记下 `chat.id`
4. **把 bot 拉进群并设为管理员**，至少授予以下权限：
   - 发送消息
   - 管理话题（创建 / 关闭 / 删除 topic）
   - 删除消息（`/purgemsg` 需要）

## 环境变量

| 变量 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Secret | ✅ | — | bot token，仅存环境变量，永不进 URL |
| `TELEGRAM_WEBHOOK_SECRET` | Secret | ✅ | — | 绑定 webhook 时传给 Telegram 的官方 `secret_token`（≥16 位，字母数字下划线连字符）；此后每条 update 都带专用请求头用于防伪造 |
| `ADMIN_SECRET` | Secret | ✅ | — | `setwebhook` / `deletewebhook` 管理端点的访问凭证 |
| `SUPPORT_CHAT_ID` | Var | ✅ | — | 超级群组 ID（`-100` 开头） |
| `ADMIN_IDS` | Var | ✅ | — | 管理员 Telegram 用户 ID，逗号分隔，支持多个 |
| `MAX_MESSAGES_PER_MINUTE` | Var | — | `20` | 每用户每分钟转发上限，超限触发重新验证 |
| `VERIFY_TTL_HOURS` | Var | — | `0` | 验证有效期（小时），`0` = 永久 |
| `MAX_ATTEMPTS` | Var | — | `3` | 同一条 update 处理失败的最大重试次数，超限标记失败跳过 |
| `WELCOME_TEXT` | Var | — | 内置默认文案 | 自定义欢迎语，支持换行；字面 `\n` 会解释为换行 |

::: warning
三个 Secret 请使用**互不相同**的长随机串。
:::

## 部署方式：GitHub 集成（一键部署）

全程在浏览器中完成，无需本地环境：

1. **Fork 本仓库**
2. **连接 Git**：dashboard → Workers & Pages → Create → Workers → 连接你 fork 的仓库，生产分支选 `main`
3. **部署**：保存后自动触发首次部署；之后每次 push 到 `main` 即自动发布新版本。向导不出现变量表单（`.dev.vars.example` 条目全部注释 = 零提示），变量统一部署后面板配置——按下方「部署后收尾」以 `/selfcheck` 为对照补齐

D1 数据库的创建与绑定（变量名 `HODOR_DB`）、数据表迁移全部由部署脚本自动完成，无需在 dashboard 手动操作。环境变量在 dashboard 配置后不会被后续部署覆盖（wrangler 配置开启了 `keep_vars`）。

## 部署后收尾

按以下顺序收尾，逐步把自检清零：

1. **存活确认**：浏览器打开 `https://<worker-url>/health`，应返回 `{"status":"ok","version":"…"}`（存活探针 + 版本号）
2. **完整自检**：浏览器打开 `https://<worker-url>/selfcheck`。变量未配齐时返回 503 与 `failed` 数组，逐条列出缺失 / 非法的变量等待修复项（不回显密钥值）——据此回到 Settings → Variables 补齐 5 条必填变量（`TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` / `ADMIN_SECRET` 用**机密（Secret）**类型，`SUPPORT_CHAT_ID` / `ADMIN_IDS` 用**文本（Text）**类型；4 条选填按需配置，均有内置默认值）
3. **绑定 webhook**：浏览器打开 `https://<worker-url>/setwebhook/<你的 ADMIN_SECRET>`，回显 bot 身份即成功（详见[运维手册](/guide/ops.md)）
4. **复查自检**：再次打开 `/selfcheck`，应全绿返回 `{"status":"ok","version":"…"}`
5. **聊天验收**：用 Telegram 账号直接给 bot 发文本（无需 `/start`）→ 收到欢迎语 + 数学题验证码 → 点对答案 → 群组出现该用户的 topic（置顶含 ✅ 已验证）且消息中继；管理员在 topic 回复，用户私聊收到
6. **说明**：阶段 1–6 已交付并真机验收——文本 + 7 类媒体直传、欢迎语（`WELCOME_TEXT` 可配置）、用户信息置顶、数学题 / 纯按钮人机验证（开关 / 模式 / 有效期可配）、分钟限频、双向消息账本与 `/help` `/ban` `/unban` `/note` `/risk` `/verifyon` `/verifyoff` `/verifymode` `/archive` `/deluser` `/purgemsg` `/wipealldata` 全套管理命令（setwebhook 时自动注册到客服群命令菜单）；阶段 7 公开发布面（`/selfcheck` 完整自检、运维 SQL、发布回归）已交付，真机验收进行中，见 [TODO 阶段计划](/todo/index.md)

## 后续如何更新

fork 用户手动跟随官方更新的步骤已独立成页，见[发布与更新](/guide/release.md)。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 部署后 bot 无响应 | webhook 未绑定；或 `TELEGRAM_WEBHOOK_SECRET` 与绑定时不一致（update 校验 401），重新执行 setwebhook |
| 消息进了群但没建 topic | bot 缺少「管理话题」权限 |
| `/purgemsg` 执行失败 | bot 缺少「删除消息」权限 |
| 突然全部请求 429 | CF 免费套餐每日 10 万请求上限用尽，见[运维手册 · 故障排查](/guide/ops.md#故障排查) |
