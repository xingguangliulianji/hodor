# 运维手册

## Webhook 绑定与解绑

部署后只需绑定一次。Worker 内部用 env 里的 `TELEGRAM_BOT_TOKEN` 调 Telegram API，token 永不出现在 URL 中。

**绑定**：浏览器直接访问（也可用 curl）：

```
https://<worker-url>/setwebhook/<ADMIN_SECRET>
```

Worker 会把 `TELEGRAM_WEBHOOK_SECRET` 作为官方 `secret_token` 一并注册，成功后页面回显 bot 身份（@username / bot ID）供确认。

**解绑**：同路径换成 `deletewebhook`，即 `https://<worker-url>/deletewebhook/<ADMIN_SECRET>`。

::: tip
访问返回 `401`「无效的管理密钥」表示 URL 路径段与 env 中的值不一致（刚更换过，或复制有误）：核对 dashboard 中的 `ADMIN_SECRET` 后用新链接重试即可。错误提示不区分「不存在 / 不正确」，避免枚举探测。
`ADMIN_SECRET` 泄漏的唯一影响是别人能替你重绑 webhook；随时可在 dashboard 换新值，消息流不受影响。
:::

## 更换 Token

### 情况一：同一个 bot 重新生成 token（如泄漏后 revoke）

bot 身份（bot_id）不变，所有数据继续有效：

1. env 里还是旧 token 时，先访问 `deletewebhook` 解绑
2. dashboard 把 `TELEGRAM_BOT_TOKEN` 换成新值
3. 再访问 `setwebhook` 重新绑定

### 情况二：换一个新的 bot

对系统而言这是全新身份：老用户在新 bot 里 `/start` 会创建新记录、新 topic；旧 topic 的绑定仍挂在旧 bot 下，**消息与用户不会自动迁移**（迁移能力属 P2）。

::: warning 严格按顺序操作
否则两个 bot 会同时把 update 推到同一个 URL，而 update 本身不带 bot 身份，Worker 将无法区分消息属于哪个 bot。

```
① 旧 token 还在 env 时 → deletewebhook（解绑旧 bot）
② dashboard 改 TELEGRAM_BOT_TOKEN 为新 bot
③ setwebhook（绑定新 bot）
④ 在旧 bot 里人工广播「客服已迁移，请添加新 Bot @xxx」
   （这步只能人工：换 env 后旧 token 已不在系统里）
```
:::

## 修改密钥的影响

| 改动 | 影响 |
| --- | --- |
| `ADMIN_SECRET` | 零影响，仅管理端点换钥匙；旧链接失效，用新值重新访问即可 |
| `TELEGRAM_WEBHOOK_SECRET` | 改完**必须重新 setwebhook**：旧注册还带着旧 secret，update 校验会 401 |
| `TELEGRAM_BOT_TOKEN` | 见上方「更换 Token」 |

## 健康自检与版本

两个公开只读端点，各管一件事：

**`GET /health` — 存活探针 + 版本号**。零外部依赖（不查变量、不查库、不调 Telegram），可供 uptime 监控高频访问：

```json
{"status":"ok","version":"1.1.0"}
```

部署后或每次更新后建议访问一次，确认服务存活并核对版本号。

**`GET /selfcheck` — 完整自检**。按 环境变量 → 数据库七表 → Webhook 绑定 的固定顺序逐项检查：全部通过返回 `200 {"status":"ok","version":"…"}`；有未通过项返回 503 与 `failed` 数组，逐条给出中文失败原因（不回显任何密钥值）。刚部署、变量还没配齐的新实例也能访问它定位缺失项。

常见 `failed` 项与处置：

| failed 文案（节选形态） | 处置 |
| --- | --- |
| `必填变量未配置：TELEGRAM_BOT_TOKEN、…`、`SUPPORT_CHAT_ID 非法：…`、`密钥变量取值重复：…`、`MAX_ATTEMPTS 已配置但非法（正整数）…` 类 | 面板 Worker → 设置 → 变量和机密 补齐 / 修正对应变量后重试（选填值非法时运行时已回退默认值，failed 项属提示性质） |
| `数据库缺表：…（迁移可能未执行，请在构建日志确认 migrations 步骤）` | 查看构建日志安装阶段的 `[provision]` 与迁移输出：确认建库 / 复用是否成功、迁移是否执行或失败 |
| `webhook 未绑定，请访问 /setwebhook/<ADMIN_SECRET> 完成绑定` | 浏览器访问 `/setwebhook/<ADMIN_SECRET>` 完成绑定 |
| `webhook 指向错误地址：…（应为 …，请重新执行 /setwebhook）` | 重新执行 `/setwebhook/<ADMIN_SECRET>`（常见于换了 Worker 地址 / 域名后未重绑） |
| `Webhook 状态未知：getWebhookInfo 调用失败（…）`、`Telegram 最近投递错误：…` | Telegram 侧问题：稍后重试；持续出现时检查 token 是否已被吊销、网络策略 |

- **部署与更新**：push 到 main 即自动部署新版本

## 版本管理

发布新版本（维护者）与跟随更新（fork 用户）已独立成页，见[发布与更新](/guide/release.md)。

## 常用 SQL

在 Cloudflare dashboard → Storage & Databases → hodor 数据库 → Console 中直接粘贴执行（`123456789` 替换为目标 user_id）。

完整的运维查询包见仓库 `scripts/d1-console.sql`：总览计数、单用户全档案、topic 绑定与归档清单、消息账本（按用户 / 按 topic）、失败 update、settings / bots、孤儿检测，以及隔离在「危险区」段的维护语句。以下只保留最常用的三条速查，内容与该文件对应条目一致。

**查用户（users 全部状态列 + topic 绑定与备注）**：

```sql
SELECT
  u.user_id, u.first_name, u.last_name, u.username,
  u.status, u.is_banned, u.is_risk, u.is_verified, u.verified_at,
  u.verify_answer, u.verify_msg_id,
  u.rate_window_start, u.rate_count, u.last_notice_at, u.risk_notice_at,
  u.first_seen_at, u.last_seen_at,
  t.thread_id, t.title AS topic_title, t.status AS topic_status,
  t.note, t.pinned_msg_id, t.created_at AS topic_created_at, t.closed_at
FROM users u
LEFT JOIN topics t ON t.bot_id = u.bot_id AND t.user_id = u.user_id
WHERE u.user_id = 123456789;
```

**查某用户的最近消息**：

```sql
SELECT
  direction, content_type, group_msg_id, private_msg_id, created_at
FROM messages
WHERE user_id = 123456789
ORDER BY created_at DESC
LIMIT 50;
```

**查处理失败的 update（毒丸排查）**：

```sql
SELECT
  update_id, attempts, created_at
FROM processed_updates
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 20;
```

::: warning 维护语句不在此页
清理类 SQL（重置失败 update、按用户清理、一键全清）**没有确认步骤，粘贴执行即生效**，全文集中在 `scripts/d1-console.sql` 的「危险区」段（带醒目警告与影响范围说明）。日常清理优先使用带两步危险确认的 topic 内命令 `/deluser` / `/wipealldata`（见[功能介绍](/guide/features.md)）。
:::

## 故障排查

::: info 适用范围
标 ★ 的为当前阶段（阶段 4）已适用；其余涉及的功能（更多管理命令等）在对应阶段交付后生效。
:::

| 现象 | 排查 |
| --- | --- |
| ★ bot 完全无响应 | ① 先确认 webhook 已绑定：访问 `/setwebhook/<ADMIN_SECRET>` 回显身份即已绑定（完整自检 `GET /selfcheck` 已交付：未绑定 / 指向错误会在 `failed` 中逐条点名）；② `npx wrangler tail hodor` 实时日志看请求是否到达、有无 401——secret 头不符说明 `TELEGRAM_WEBHOOK_SECRET` 与注册时不一致，重新 setwebhook；③ 日志无请求 = Telegram 侧未推送，检查 webhook 绑定 |
| ★ 消息进群但为空 / 报 sendMessage 400 | `wrangler tail` 看具体 API 报错文案；若为「message to copy not found」类，参考 T21 运行时说明（[TODO](/todo/p1.md)） |
| ★ 验证码收不到 | 用户是否已被 ban（封禁门不发出题）；日志中 sendMessage 是否报 403（用户已停用 / 拉黑 bot）；60 秒内重复消息受提示频控限制（每分钟最多 1 次提示） |
| 消息转发了但没建 topic，或 topic 操作失败 | ★ bot 在群里缺少「管理话题」权限 |
| `/purgemsg` 执行失败（阶段 6 起） | bot 缺少「删除消息」权限 |
| ★ 提示「找不到对应用户」 | topic 是僵尸（绑定行不存在或已被手动清理）：按提示手动关闭或删除该 topic |
| 突然全部请求 429 | CF 免费套餐每日 10 万请求上限用尽（每条消息约消耗 1 次 CF 请求 + 若干 Telegram API 出站调用）；人机验证默认开启已拦截大部分刷量，可调低 `MAX_MESSAGES_PER_MINUTE`，或升级付费计划 |
