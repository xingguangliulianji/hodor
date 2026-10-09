# 错误处理 —— Telegram 三态语言

> 所有 Telegram API 错误如何分类与消费。S2(2026-09-28)确立。

---

## 约定:TelegramResult 是流水线代码唯一的错误语言

**内容**:`src/telegram/types.ts` 定义 `TelegramResult<T> = TelegramOk<T> | TelegramError`,
其中 `TelegramError.kind` 为 `'retryable' | 'permanent'`(可选 `retryAfterSeconds`、
`errorMessage`;`permanent` 还携带 `errorCode?: number`)。HTTP/JSON 细节的分类**只**
发生在 `src/telegram/client.ts`(`request()`)内部;流水线模块(S3 起)永远看不到
状态码——只根据 `kind` 分支。

**原因**:落实 docs/03 的规则——S5 将 403 分支为 `bot_blocked_by_user` 时,无需在
HTTP 层嗅探字符串;单一分类点,可独立测试。

### 分类矩阵(逐字摘自 design.md 决策表)

| Telegram 响应 | Kind | 附加语义 |
|---|---|---|
| 200 + `ok:true` | Ok | 结果直接透传 |
| 200 + `ok:false` | permanent | errorMessage = description;信封有 `error_code` 时透传为 `errorCode` |
| 429,`retry_after ≤ 3s` | **原地重试恰好一次**(setTimeout) | 仍 429 → retryable 携带新值;绝不重试两次 |
| 429,`retry_after > 3s` 或缺失 | retryable | 向上重新抛出 → inbox 5xx → Telegram 重投递 |
| 403 | permanent | `errorCode === 403` 驱动 `bot_blocked_by_user`(S5)——按数字码分支,绝不嗅探字符串 |
| 400 | permanent(毒丸) | 绝不重试;`errorCode` 透传 |
| 5xx / 网络错误 / 非 JSON | retryable | |
| 其他 4xx | permanent | 保守默认;`errorCode` 透传 |

### 消费方规则(S3 起)

- `retryable` → 让请求失败(5xx),交给 inbox 状态机 + Telegram 重投递去重试;
  绝不在流水线代码内循环。
- `permanent` → 按 docs/03 逐项决定:标记 `processed`(毒丸 / 被屏蔽用户),绝不返回 5xx。
- 不要在 `client.ts` 之外新增分类分支。

## 场景:管线副作用的排序与系统消息语义(阶段 3 / T22–T26,2026-09-30 确立)

### 1. 范围 / 触发条件

在中继管线(入站 / 出站)新增任何副作用(欢迎语、置顶、提示、验证码、账本、
未来阶段的限频 / 封禁提示等)时,本节排序与语义契约生效。

### 2. 签名

- 入站 canonical order:`extractContent → ensureUser → topic(含置顶 4a/4b) →
  欢迎语(claimNoticeSlot 门控) → relayContent → insertMessage`。
- 出站 canonical order:`extractContent → 管理员校验 → 反查绑定(未绑定/closed →
  T26 提示后结束) → relayContent → insertMessage`。

### 3. 契约

- **非中继副作用一律排在中继之前;中继之后只允许账本写入**。系统类消息
  (欢迎 / 置顶 / 提示)**不入 messages 账本**(非对话内容)。
- 账本行只在**中继成功后**写入;中继 permanent(消息被丢弃)不写行。
- 频控提示走原子认领:`UPDATE ... SET last_notice_at=? WHERE ...
  (last_notice_at IS NULL OR last_notice_at <= ?) AND` `meta.changes === 1` 才发送。
- **账本后附着物完全 best-effort(阶段 5 确立)**:治理提醒类副作用(高危 24h
  提醒)排在中继与账本**全部成功之后**,先原子认领时间窗再发送,**两种失败一律
  warn 吞、绝不抛**——它是主链的附着物而非环节,抛出会让重推重发用户消息
  (放大面);窗口已消耗,本轮丢失由下个窗口的下一条消息补上。

### 4. 校验与错误矩阵

| 副作用 | retryable | permanent |
|---|---|---|
| 中继前副作用(置顶 / 欢迎 / 提示) | 抛 → 重推重走该步骤(中继未发生,不产生重复中继) | warn + 跳过,主流程继续 |
| 中继本身 | 抛 → 重推(at-least-once 已知代价) | warn + 消息丢弃,**不写账本** |
| 账本 insertMessage | 原样抛 → 重推(可能重发一次中继,绝不提前 markProcessed 掩盖) | —(D1 错误一律按 retryable 对待) |
| claimNoticeSlot 已赢但发送失败 | 抛;slot 已消耗,宁可丢一条欢迎语也不重复轰炸 | warn + 跳过 |
| 账本后附着物(高危 24h 提醒,阶段 5) | **warn 吞(不抛)**——防重推放大用户消息重复 | warn 吞 |
| 命令内置顶刷新(阶段 5) | warn 吞(best-effort——确认回复已保证管理员反馈) | warn 吞 |

### 5. 正例 / 基线 / 反例

- **正例**:欢迎语 send 抛 retryable → 整条 update 5xx → 重推时 slot 已占、
  topic 已在,中继只发生一次。
- **基线**:中继成功、账本写失败 → 500 重推 → 中继可能重发一次 + 账本行最终写入
  (test/inbound-ledger-failure.test.ts 固化:保持 processing、不提前标记)。
- **反例**:把欢迎语排在中继之后——欢迎语 retryable 失败会连带已发出的中继一起
  重推,制造无谓的用户消息重复。

### 6. 必需测试

每个新增副作用的用例必须断言:三态各自路径的最终 inbox 状态、系统消息不产生
账本行、以及「该副作用失败时中继不重复」(排序保证)。

### 7. 错误 vs 正确

#### 错误

```ts
await relayContent(...);          // 先中继
await sendWelcome(...);           // 欢迎失败 retryable → 抛 → 重推 → 中继重复
```

#### 正确

```ts
await maybeSendWelcome(...);      // 先副作用(失败可安全重推)
await relayContent(...);          // 后中继
await insertMessage(...);         // 中继之后只有账本(失败抛,at-least-once 已定稿)
```

## 必需测试

- 分类矩阵 + 两条 429 路径,并断言调用次数(test/telegram-client.test.ts)。
- 消费方(S3 起):每个 `kind` 分支都要断言最终的 inbox 状态 / HTTP 响应。

## 已知后续(记录在各任务 PRD 中)

- ~~S5 决策:`permanent` 是否增加 `errorCode?: number`~~ —— 已在 S5(2026-09-28)解决:
  `permanent` 携带 `errorCode?: number`(信封 `error_code` 透传;`200 + ok:false` 路径
  同样如此)。消费方按数字码分支,绝不按 `errorMessage` 文本。
- ~~S3:补充缺失场景「200 + 合法 JSON 但无 `ok` 字段 → retryable」~~ —— 已完成
  (test/telegram-client.test.ts)。

## 有界例外:permanent 子类谓词(阶段 6 / T38–T39,2026-10-08 确立)

「绝不嗅探字符串」的完整口径:**有数字码可分时按数字码;无数字码、且 description
是唯一信号时,允许在唯一模块 `src/pipeline/errors.ts` 内对已消毒的 `errorMessage`
做 permanent 子类判定**。约束:

- 谓词集中收敛在 `src/pipeline/errors.ts`(isTopicGoneError / isMessageGoneError /
  isTopicClosedError / isTopicNotModifiedError),**绝不**在 client 分类矩阵内分支、
  绝不散落在各 pipeline 文件。
- 判定原则:**宁可漏判不可误判**——未知 permanent 一律落各消费方默认行为；topic-gone 只能
  清理死绑定，TOPIC_CLOSED 只能触发 reopen-and-retry，二者严禁混淆。
- 新增谓词必须配套:单元断言(命中 / 不命中 / undefined 三态)与消费方用例
  (test/stage6.test.ts「errors: 错误摘要谓词」describe)。
- 触发背景:Telegram 对「topic 已被原生删除」只回 400 + description
  ("message thread not found" / "TOPIC_ID_INVALID"),无独立数字码;该判定驱动
  topics 绑定回收自愈(阶段 6 design.md §五.2)。

## 场景:原生 forum topic close/reopen 与入站恢复(阶段 6)

### 1. 范围 / 触发

客服群原生 `forum_topic_closed` / `forum_topic_reopened` service message，或向原生
closed topic 中继返回 `TOPIC_CLOSED`。Telegram Core API 将 closed 定义为该 topic
不接受消息；不能假设管理员 / bot 有发送例外。

### 2. 签名

- `classifyUpdate(update, supportChatId) -> "topic_event"`：仅客服群、正整数
  `message_id`、正整数 `message_thread_id`、且恰好一个合法 service flag 时成立。
- `handleTopicEvent(db, botId, message) -> Promise<void>`：只投影 `topics.status`
  与 `closed_at`，不读写 users/messages。
- `isTopicClosedError(errorMessage?)` / `isTopicGoneError(errorMessage?)` /
  `isTopicNotModifiedError(errorMessage?)`：均为 `src/pipeline/errors.ts` 中唯一的
  permanent 子类谓词，不改变 client 的 `retryable|permanent` 分类。

### 3. 契约

- service close → `topics.status='closed', closed_at` 首次写入时间；重复 close 不刷新
  原 `closed_at`。service reopen → `status='open', closed_at=NULL`。不存在绑定则安全忽略。
- service message 永不进入 outbound relay、messages ledger 或用户状态变更。
- inbound relay permanent `TOPIC_CLOSED` → 对同一 `thread_id` 调 `reopenForumTopic`；
  Ok 或 `TOPIC_NOT_MODIFIED` 后同步 DB open，并对**同一个当前 payload**有界重试一次。
  retryable reopen → 抛；明确 topic-gone → 走删除自愈；其他 permanent 保留 mapping 并 warn/drop。
- topic-gone 是删除而不是关闭：只匹配明确的 deleted-topic description；open-row 自愈
  创建替代 topic 并转发当前 payload 一次，closed-row reopen 自愈也处理当前 payload。
- native reopen event 只改变 topic state，不等同 `/archive`；软归档用户的验证状态仍由 users
  真值控制，重验证后再进入 topic 路由。

### 4. Validation & Error Matrix

| 输入/调用结果 | 消费行为 |
|---|---|
| 客服群合法 `forum_topic_closed` / reopened | update topic row；200；零 relay/ledger |
| 其他群、缺/非正 message_id、缺/非法 thread、双 service flags | ignore，零 DB 写 |
| relay `TOPIC_CLOSED` | reopen API；不会 delete mapping |
| reopen Ok / TOPIC_NOT_MODIFIED | 同 payload retry 一次；第二次 Ok 才写 ledger |
| reopen retryable | 抛，webhook 5xx 重推；DB state 不误删 |
| reopen `message thread not found` / TOPIC_ID_INVALID | topic-gone rebuild；当前普通消息继续 |
| 其他 permanent | warn/drop，绑定保留 |

### 5. Good / Base / Bad

- **Good**：关状态与 topic-gone 分谓词；`TOPIC_CLOSED` reopen + 单次 retry 同一个 update payload；第二次失败时不循环、不写账本。
- **Base**：service event 更新状态，重推同事件只再次投影相同状态。
- **Bad**：把 `TOPIC_CLOSED` 当 topic-gone 删除绑定；或把 reopen permanent 吞掉后继续写账本；或在 closed topic 发 final confirmation。

### 6. 必需测试

- classify 合法 / malformed service event 与 foreign chat；webhook topic_event 写 DB 并断言零 Telegram relay、零 ledger。
- 重复 close 保持 closed_at 稳定；reopen 清 closed_at；users 验证态 / note / ledger 不变。
- inbound `TOPIC_CLOSED`：reopen 只调用一次，payload 到原 thread 并只记一条账本；retryable、TOPIC_NOT_MODIFIED、topic-gone、其他 permanent 各断言终态。
- 原生删除 open row：第一次 old-thread send permanent，当前 payload 在替代 thread 成功并只写一条账本。
- `/start` + open dead binding：不得伪探测 / 不得把 start 写账本；文档注明普通消息才触发检测（Bot API 无只读 topic 查询）。

### 7. Wrong vs Correct

#### Wrong

```ts
if (!relay.ok && relay.kind === "permanent") {
  await deleteTopicBinding(db, botId, userId); // TOPIC_CLOSED 也会误删绑定
  return;
}
```

#### Correct

```ts
if (!relay.ok && relay.kind === "permanent" && isTopicClosedError(relay.errorMessage)) {
  await reopenForumTopic(...);
  // 仅 Ok / TOPIC_NOT_MODIFIED 时把同一 payload 重试一次；失败不写账本
}
```
