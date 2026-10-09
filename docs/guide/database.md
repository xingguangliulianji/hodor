# 数据表

hodor 只依赖一个 D1 数据库，共七张表。

**全局约定**：

- 所有表带 `bot_id` 维度（bot 的 Telegram 用户 ID），为多机器人（P2）预留；v1 恒为当前 bot 的 ID
- 时间戳统一 ISO-8601 UTC 文本
- 布尔值用 `0` / `1` 整数

## bots — bot 身份

`setwebhook` 绑定时由 `getMe` 自动写入 / 更新。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bot_id` | INTEGER PK | bot 的 Telegram 用户 ID |
| `username` | TEXT | @username |
| `display_name` | TEXT | bot 显示名称 |
| `created_at` | TEXT | 首次绑定时间 |

## users — 用户档案、验证与限频状态

UNIQUE `(bot_id, user_id)`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bot_id` / `user_id` | INTEGER | 联合唯一，用户 Telegram ID |
| `first_name` / `last_name` / `username` | TEXT | 展示缓存，置顶信息用 |
| `status` | TEXT | `active` / `deleted`（`/archive` 后置 deleted 表示软归档；重新通过验证并恢复会话后置 active；`/deluser` 物理删除时删行） |
| `is_banned` | 0/1 | `/ban` 禁言标记 |
| `is_risk` | 0/1 | `/risk` 高危标记 |
| `is_verified` / `verified_at` | 0/1, TEXT | 验证状态与通过时间 |
| `verify_answer` / `verify_msg_id` | INTEGER | 待验证题目的正确答案与验证消息 ID（出题时写入，通过后清空） |
| `rate_window_start` / `rate_count` | TEXT, INTEGER | 60 秒固定窗口限频计数 |
| `last_notice_at` | TEXT | 提示类回复（欢迎语 / 验证码 / 禁言 / 超限提示）的限频时间戳，每用户每分钟 1 次 |
| `risk_notice_at` | TEXT | 高危用户 topic 提醒的上次发出时间（24 小时窗口）；提醒发出时写入，`/risk` 重新标记时清空（窗口重置） |
| `first_seen_at` / `last_seen_at` | TEXT | 首次 / 最近活跃时间 |

## topics — 用户 ↔ topic 双向映射（核心表）

UNIQUE `(bot_id, user_id)` **和** UNIQUE `(bot_id, thread_id)` 双向唯一：

- 入站：按 `(bot_id, user_id)` 查转发目标 topic
- 出站：管理员在 topic 发言，按 `(bot_id, thread_id)` 反查目标用户

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bot_id` / `user_id` | INTEGER | 联合唯一，所属用户 |
| `thread_id` | INTEGER | topic 的 `message_thread_id`，与 bot_id 联合唯一 |
| `title` | TEXT | 话题名，取用户昵称（`first_name`，回退 `@username` / 用户 ID） |
| `status` | TEXT | `open` / `closed`（原生 forum_topic_closed/reopened service message 同步；`/archive` 也关闭，用户回访时 reopen；`/deluser` 硬删时删行） |
| `pinned_msg_id` | INTEGER | 置顶的用户信息消息 ID（建档置顶时写入；昵称变更自动刷新，risk / unrisk / archive 后 best-effort 更新；`/purgemsg` 重置） |
| `note` | TEXT | 管理员备注（`/note` 写入、`/unnote` 清空，展示于置顶信息）；随 topic 终身保留，`/archive` 后仍在；`/deluser` 物理删除时清除 |
| `created_at` / `closed_at` | TEXT | |

::: tip 设计意图
`topics.status` 表示 Telegram topic 开关状态：由原生 close/reopen service message 同步，也由 `/archive` 关闭、用户回访恢复。`users.status='deleted'` 表示 `/archive` 的软归档状态；users/topics/messages 行仍在。`/deluser` 是硬删除，会移除对应 users/topics/messages 行及 Telegram topic；不删除用户与 bot 的私聊窗口历史。
:::

## messages — 消息账本

`/purgemsg` 与运维查询的数据来源：逐条 `deleteMessage`（按 `group_msg_id`，双向含管理员发言）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK | 自增 |
| `bot_id` / `user_id` / `thread_id` | INTEGER | 归属 |
| `direction` | TEXT | `in`（用户 → 群）/ `out`（群 → 用户） |
| `group_msg_id` | INTEGER | 群内消息 ID（`/purgemsg` 用） |
| `private_msg_id` | INTEGER | 私聊侧消息 ID |
| `content_type` | TEXT | text / photo / video / voice / audio / document / sticker / animation |
| `created_at` | TEXT | |

索引：`(thread_id, created_at)`、`(user_id, created_at)`。

`/purgemsg` 完成后（含部分失败）会删除该 topic 的全部账本行——账本与群内实况对齐；删除失败的消息不再被追踪，可手动删除。原生删除 topic 后自愈只清旧 topics 绑定行，历史账本行保留（`thread_id` 悬空无害）。`/deluser` 物理删除则会删除该用户对应账本行；Telegram 私聊消息不在删除范围内。`/wipealldata` 确认后先按本表删除全部群内话题（General 除外），成功后清空全表。

## settings — 运行时开关

| key（PK） | value | 说明 |
| --- | --- | --- |
| `verify_enabled` | `1` / `0` | `/verifyon` / `/verifyoff` |
| `verify_mode` | `math` / `button` | `/verifymode` |

存库而非环境变量的原因：命令切换需要即时生效，不改 env、不重新部署。

## processed_updates — 幂等与重试

UNIQUE `(bot_id, update_id)`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | TEXT | `processing`（认领占位，处理成功后置 `processed`）/ `processed` / `failed` |
| `attempts` | INTEGER | 失败重推计数，每次认领接管 +1，≥ `MAX_ATTEMPTS` 置 `failed` 跳过（防毒丸） |
| `created_at` | TEXT | 最近认领时间（每次重试 / 接管刷新）；超过 60 秒的 `processing` 行视为崩溃残留，可被下一次重推接管 |

## delete_confirmations — /deluser 二次确认（阶段 6）

PK `(bot_id, prompt_msg_id)`：一条确认按钮消息一行，`prompt_msg_id` 为该警告消息在客服群的 message_id。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` / `thread_id` | INTEGER | 按钮目标用户与话题；回调必须与行完全一致 |
| `started_at` | INTEGER | 按钮发起时间戳（秒）；60 秒有效期判定 |
| `status` | TEXT | `pending` / `cancelled` / `confirmed`；取消与确认各用单条原子 `UPDATE ... WHERE status='pending'` 裁决，先到先得 |
| `confirm_callback_id` | TEXT | 确认获胜的 callback id；仅该 id 的后续 webhook 重推可继续执行（TG 已删而 D1 清理失败的收敛），其他回调一律拒绝 |

确认 `UPDATE` 的 `WHERE` 同时要求 topics 当前仍存在该 `(bot_id, user_id, thread_id)` 双向绑定。`/deluser` 删除用户时随 users 一并清理该表行；`/wipealldata` 确认后全表清空（清库前先按 topics 表删除全部群内话题）。

## 表间关系

```
bots ──1:n── users ──1:1── topics
              │              │
              └──1:n── messages ──┘   （messages 同时归属 user 与 topic）

settings、processed_updates、delete_confirmations 为独立表
```
