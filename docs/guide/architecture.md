# 原理与架构

## 总览

```
                        Telegram
             ┌──────────┐    │    ┌──────────────┐
             │ 用户私聊  │    │    │  超级群组      │
             │ (bot DM) │    │    │  (topics)     │
             └────┬─────┘    │    └──────┬───────┘
                  │ update   │           │ update
                  │ (Webhook)│           │ (Webhook)
                  ▼          │           ▼
             ┌─────────────────────────────────┐
             │         Cloudflare Worker        │
             │   /webhook ← Telegram 推送入口    │
             │   路由层 → pipeline → store       │
             │              ↓         ↑         │
             │        telegram client (API)     │
             └───────────────┬─────────────────┘
                             │ SQL
                             ▼
                       ┌──────────┐
                       │  D1 数据库 │ （七张表）
                       └──────────┘
```

入站（用户 → 群组）与出站（群组 → 用户）共用同一个 `/webhook` 入口，由消息来源分流：私聊消息走入站管线；来自 `SUPPORT_CHAT_ID` 且带 `message_thread_id` 的消息走出站管线。

## 发布与更新

发布与更新链路（Release Please 自动发版、fork 用户手动跟随）已独立成页，见[发布与更新](/guide/release.md)。

## 端点与鉴权

| 端点 | 方法 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `/webhook` | POST | `X-Telegram-Bot-Api-Secret-Token` 头 == `TELEGRAM_WEBHOOK_SECRET` | Telegram update 唯一入口 |
| `/setwebhook/<ADMIN_SECRET>` | GET | `ADMIN_SECRET`（路径段） | 绑定 webhook，token 从 env 读取 |
| `/deletewebhook/<ADMIN_SECRET>` | GET | 同上 | 解绑 webhook |
| `/health` | GET | 无 | 存活探针 + 版本号 |
| `/selfcheck` | GET | 无 | 完整自检：环境变量 / 七张表 / webhook 指向；有未通过项 503 + `failed[]` |

::: info 鉴权失败的响应约定
管理端点的所有鉴权失败（secret 缺失、不存在、不正确）一律返回 `401` + 「无效的管理密钥」，**不区分具体原因**，避免给探测者反馈某个 secret 是否存在过。`/webhook` 的 secret 头不符同样只返回 `401`，不携带任何区分信息。
:::

### 自检（/selfcheck）

部署完成后访问 `GET /selfcheck` 即可确认整条链路就绪。它按固定顺序（环境变量 → 数据库 → Webhook）逐项检查并返回 JSON（公开只读端点，不回显任何密钥值）：

| 检查项 | 内容 |
| --- | --- |
| 环境变量 | 5 条必填变量已配置且格式合法（`SUPPORT_CHAT_ID` 为 `-100` 开头整数、`ADMIN_IDS` 可解析出至少一个合法 ID）；三个 Secret 互异；选填变量（`MAX_ATTEMPTS` / `MAX_MESSAGES_PER_MINUTE` / `VERIFY_TTL_HOURS`）已配置但值非法也可定位 |
| 数据库 | `HODOR_DB` 绑定可用、当前 schema 全部七张表存在（users / topics / messages / settings / processed_updates / bots / delete_confirmations，迁移已执行） |
| Webhook 绑定 | 通过 `getWebhookInfo` 确认 webhook 已指向本 Worker 的 `/webhook`；未绑定、指向错误地址、Telegram 调用失败均可定位 |

- 全部通过：`200 {"status":"ok","version":"x.y.z"}`
- 有未通过项：`503 {"status":"error","version":"x.y.z","failed":["...逐项失败原因..."]}`（如「webhook 未绑定，请访问 `/setwebhook/<ADMIN_SECRET>` 完成绑定」）

`TELEGRAM_BOT_TOKEN` 未配置时不发起 Telegram 调用，Webhook 项按「无法检查」报告，其余检查照常执行——完全未配置变量的全新实例也能用它定位缺失项。

::: info 端点演进说明
阶段 1 曾把完整自检规划在 `/health` 本体上，当时未区分「存活探针」与「就绪检查」。阶段 7 起拆分为两个端点：`/health` 是纯存活探针（零外部依赖，供 uptime 监控高频访问）；`/selfcheck` 供部署验证与排障——完整检查含一次 Telegram API 调用，不宜挂在探针上（外部故障会被放大为探针失败、消耗 API 配额）。
:::

### 三种密钥的分工

| 密钥 | 方向 | 作用 |
| --- | --- | --- |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram → Worker | `setWebhook` 的官方 `secret_token` 参数；此后每条 update 携带专用请求头，Worker 校验，防止任何人伪造 POST 冒充 Telegram |
| `ADMIN_SECRET` | 管理员 → Worker | 管理端点的访问凭证，作为 URL 路径段使用，浏览器可直接访问 |
| `TELEGRAM_BOT_TOKEN` | Worker → Telegram | bot 身份凭证，仅存环境变量，永不进 URL / 日志 |

## 消息流水线

### 入站（用户 → 群组 topic）

```
update 到达
 │ ① 校验 secret 头
 │ ② processed_updates 幂等去重（重复推送直接 200）
 │ ③ 内容抽取：文本 + 7 类媒体；支持集之外 → 安全忽略 200
 │ ④ 用户不存在 → 建档（首条消息无论类型、是否 /start 都视为开始）
 │ ⑤ 封禁门：已 ban → 「你已被禁言」提示（每用户每分钟 ≤1 次），丢弃
 │ ⑥ 验证门（settings.verify_enabled 关闭时整门跳过、记录保留）：
 │      未验证 或 VERIFY_TTL_HOURS 过期 → 出题 / 重发验证码（每用户每分钟 ≤1 次），丢弃
 │      （首联 = 欢迎语 + 首题成对发出；答题前零 topic、零中继、零账本；
 │        题面形态随 settings.verify_mode：数学题 4 按钮 / 纯按钮单按钮）
 │ ⑦ 限频门：60 秒固定窗口计数 ≥ MAX_MESSAGES_PER_MINUTE？
 │      → 标记未验证 + 发新验证码（提示含限频数字），丢弃
 │ ⑧ 确保 topic：查 topics 表；无则 createForumTopic + 置顶用户信息
 │      （置顶消息 ID 落库，昵称/验证/高危/备注变化自动刷新）；native close / archive 用户回访 → reopenForumTopic
 │ ⑨ 欢迎语：新用户或 /start 触发（每用户每分钟 ≤1 次）；
 │      /start 到此结束——入口命令不中继、不落账本
 │ ⑩ per-type send 中继到 topic → 成功后写 messages 账本（双端消息 ID）
 │      → 高危用户 24 小时一次话题内提醒（完全 best-effort）→ 返回 200
```

### 出站（群组 topic → 用户）

```
update 来自 SUPPORT_CHAT_ID 且带 message_thread_id
 │ ① 幂等去重
 │ ② 发言者 ∈ ADMIN_IDS？
 │      否 + / 命令 → 「该命令仅客服管理员可用。」提示，结束
 │      否 + 普通文本 → 静默忽略
 │ ③ 内容抽取（支持集之外安全忽略）
 │ ④ 管理员 / 开头 → 命令管线（/help /ban /unban /note /unnote /risk /unrisk
 │      /archive /deluser /purgemsg /wipealldata /verifyon /verifyoff /verifymode；
 │      命令不中继不账本；归档/物理删除需绑定，其余按命令语义授权）
 │ ⑤ thread_id 反查 topics → user；native closed topic 不接受新群消息，原生 reopen 服务事件同步 DB
 │ ⑥ open topic 的管理员消息 per-type send 私聊送达 → 成功后写 messages 账本 → 返回 200
```

## 验证状态机

> 阶段 5 起验证可运行时配置：`/verifyon` / `/verifyoff` 全局开关（settings 表持久化，关闭期间记录保留、TTL 不判定）、`/verifymode` 数学题 ↔ 纯按钮循环切换（切换清空全部 pending 旧题，旧题回调一律失效）。置顶信息验证行三态：✅ 已验证 / ❌ 未验证 / 未启用。

```
          首条消息 / 重新 start
  [新建] ───────────────▶ [待验证] ──答题正确──▶ [已验证]
                              ▲                      │
                              │   限频超限 / VERIFY_TTL 过期
                              └──────────────────────┘
                              ▲
                              │ /archive（关闭 topic 并清验证；deluser 硬删整条记录，阶段 6）
                              └──────────────────────┘
```

- 验证码：数学题模式 `a ± b` 题目 + 4 个答案按钮，正确答案只存数据库，callback 只携带用户所选值，不在消息里泄漏答案；纯按钮模式单按钮（防护较弱，帮助与切换确认均说明）
- 答错：编辑原消息提示错误，并重新出一题
- 验证通过前的消息直接丢弃，不积压补发
- `VERIFY_TTL_HOURS`（默认 0 = 永久）：已验证用户的通过时间距 now ≥ TTL 时，下一条消息触发重验（撤验证 + 置顶降级 ❌ + 出题）

## 可靠性

- **幂等**：Telegram webhook 是至少一次（at-least-once）投递，同一 update 可能重推。`processed_updates` 表按 `(bot_id, update_id)` 去重
- **重推**：处理过程抛错时返回非 200，Telegram 会自动重新推送
- **防毒丸**：同一条 update 失败次数超过 `MAX_ATTEMPTS` 后标记 `failed` 跳过，避免坏消息无限循环
- **429**：调 Telegram API 遇 429 时按 `retry_after` 等待后原地重试一次

## 分层设计

四层各自回答一个问题，逐层委托：

| 层 | 回答的问题 | 职责 |
| --- | --- | --- |
| 路由层 | 这个请求是谁、合法性如何、交给谁 | 端点分发、鉴权、HTTP 响应码（200 / 401 / 500） |
| pipeline | 这条消息的业务流程是什么 | 入站、出站、命令三条处理管线，纯业务编排（即上方两张流程图的 ①–⑧ / ①–⑤ 步） |
| store | 数据怎么读写 | D1 访问收敛为按表划分的模块，pipeline 不写裸 SQL |
| telegram client | 怎么调 Telegram API | API 调用与错误分类（可重试 / 永久）的唯一出口 |

层间单向依赖：路由 → pipeline → store / telegram client，低层不反向调用高层。

对应到代码组织：

```
src/
  index.ts          # fetch 入口（路由层分发）
  routes/           # webhook / setwebhook（含命令菜单注册）/ health 各端点
  pipeline/
    inbound.ts      # 入站管线：三门（封禁/验证/限频）→ topic → 中继 → 账本
    outbound.ts     # 出站管线：命令分流 → 反查绑定 → 中继 → 账本 / 无绑定提示
    verify.ts       # 验证管线：出题 + 答题回调（归属/失效/重出/置顶刷新）
    commands.ts     # 命令管线：/help /ban /unban 与未知命令
    content.ts      # 内容抽取（文本 + 7 类媒体）与 per-type 中继分发
  copy.ts           # 用户可见文案唯一集中点（欢迎语 / 置顶 / 验证 / 命令 / 提示）
  store/            # users / topics / messages / settings 按表分模块
  telegram/         # client.ts：API 调用与错误分类的唯一出口
```

这样分层的直接收益是**可测试性**：pipeline 不写裸 SQL、不直接发 HTTP——数据操作全走 store 函数、Telegram 调用全走 client，验证规则、限频逻辑等核心业务可以 mock 这两个依赖做单元测试。同时路由层保持极薄，调整鉴权方式或增删端点（如管理端点从查询参数改为路径段）不影响业务流程。

## 关键设计决策

| 决策 | 理由 |
| --- | --- |
| 媒体 file_id 直传，不落盘 | `sendPhoto`/`sendVideo` 等按 file_id 原样发送（T22 已交付：7 类媒体 + 文本）；零存储成本、零 R2 依赖，部署门槛最低。代价是 Telegram 服务端为唯一存储（可接受，不做本地留存） |
| token 永不进 URL | URL 会留在浏览器历史、CF 访问日志等处，泄漏即被接管 bot。管理端点用独立的 `ADMIN_SECRET` 鉴权，token 只从 env 读取 |
| 一人一 topic，archive 后复用、deluser 后删除 | `/archive` 保留绑定 / 历史 / 备注并在回访时重开；`/deluser` 物理删除 topic + Hodor 数据；native close/reopen 服务事件同步 topic 状态 |
| 全表带 bot_id | v1 单 bot，但数据模型天然支持多 bot：未来按 bot 独立 webhook 路径接入时只改接入层，不动数据 |
| 无框架，原生 fetch | 端点总共只有 4 个，引入 Web 框架收益极低；零运行时依赖也让免费额度占用最小 |
| 提示回复限频（每用户每分钟 1 次） | 防止攻击者用「垃圾消息 → 触发提示回复」反向刷 CF 请求额度 |

## 路线图

见 [TODO](/todo/index.md)：P2 多 bot 运行时 / 换绑迁移 / TGuard 验证。

## 参考项目

hodor 的设计借鉴了以下开源项目：

| 项目 | 借鉴点 |
| --- | --- |
| [iawooo/ctt](https://github.com/iawooo/ctt) | 数学题验证码 + 答案按钮、分钟级限频超限重验、D1 + topic 映射的整体形态 |
| [SideCloudGroup/BetterForward](https://github.com/SideCloudGroup/BetterForward) | topic 置顶用户信息、管理命令设计（ban / 高危标记 / 清理会话） |
| [wozulong/open-wegram-bot](https://github.com/wozulong/open-wegram-bot) | 无状态转发思路、webhook `secret_token` 鉴权 |
