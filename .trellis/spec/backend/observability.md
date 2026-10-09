# 观测端点（/health 与 /selfcheck）规范

> 阶段 7（T07）确立的双端点契约：存活探针与完整自检分离。
> 对外契约（端点表、失败文案、演进说明）的事实源是 `docs/guide/architecture.md`；
> 本文件约束**实现侧的可执行契约**。

---

## 场景：部署自检端点（新增 / 改动检查项时）

### 1. 范围 / 触发

- 新增 / 修改 `/health`、`/selfcheck` 的响应形状或检查项
- 新增环境变量（env-config 规范）后需纳入自检
- schema 变更后七表期望集 `EXPECTED_TABLES` 需增删（与 database.md 同步契约联动）

### 2. 签名

```typescript
// src/routes/health.ts —— 只装配，检查逻辑在 src/selfcheck.ts 纯函数
handleHealth(): Response                                  // 轻量探针，无参数无外部依赖
handleSelfCheck(request: Request, env: Cloudflare.Env): Promise<Response>

// src/selfcheck.ts —— 纯检查函数，不发请求不写库（checkWebhook 消费调用结果）
checkEnv(env: Cloudflare.Env): string[]                   // 失败文案数组，空 = 通过
checkTables(db: D1Database): Promise<string[]>
checkWebhook(result: TelegramResult<WebhookInfo> | null, expectedUrl: string): string[]
```

### 3. 契约

| 端点 | 行为 | 响应 |
|------|------|------|
| `GET /health` | 零外部依赖（不查 D1、不调 Telegram） | 恒 200 `{"status":"ok","version":"…"}`（**字节级不变**，uptime 监控依赖） |
| `GET /selfcheck` | env → 七表 → webhook 顺序，三项独立、env 失败不阻断 | 全过 200 `{"status":"ok","version":"…"}`；有失败 503 `{"status":"error","version":"…","failed":[…]}` |

- 两者均无鉴权（用户决策）；**任何输出不回显密钥值**——只允许变量名、表名、非密钥原值（webhook URL、Telegram 错误原文）、client 已消毒概要。
- 缺 `TELEGRAM_BOT_TOKEN` 时不得发起 Telegram 调用（不建 client）。
- webhook 期望 URL = `new URL(request.url).origin + "/webhook"`，与 `handleSetWebhook` 同源拼法。

### 4. 校验与错误矩阵（节选，全文案以 src/selfcheck.ts 为准）

| 条件 | 结果 |
|------|------|
| 必填变量缺失 / 非法 | 对应中文 failed 文案（点名变量 / 位置） |
| 三 Secret 两两相同 | 各自一条「密钥变量取值重复」 |
| `HODOR_DB` 查询抛错 | 「数据库不可用：HODOR_DB 绑定查询失败」 |
| `getWebhookInfo` ok:false | 「Webhook 状态未知…（已消毒概要）」，自检层单次消费不再调用 |

### 5. 设计决策：严格校验与容错解析的分工（不合并）

**Context**：`src/env.ts` 的解析函数（如 `parseAdminIds`）对非法值**静默回退 / 跳过**——管线要活着；
`src/selfcheck.ts` 对同样的输入**逐条点名报错**——部署者要能定位。

**Decision**：两套语义并存是分工不是重复，**不抽公共函数强行统一**（合并必然让其中一侧失去自己的语义）。
新增环境变量时：env.ts 加容错解析（管线消费）+ selfcheck.ts 加严格校验（诊断展示）+ vitest.config.ts 钉死测试值。

### 6. 必需测试

- `test/health.test.ts`：轻量响应 `JSON.stringify` 严格相等（字节级不变的守卫）。
- `test/selfcheck.test.ts`：全过路径（SELF.fetch + stub）；破坏用例用**构造 env 直调** `handleSelfCheck`；
  每条失败用例断言响应文本不含任何密钥值；缺 token 断言 `getWebhookInfo` 零调用。
- `test/selfcheck-tables.test.ts`：**不应用迁移**的独立文件（每文件隔离 D1）断言缺表检测。
- 回归：`test/release-regression.test.ts` ⑨ 断言两端 version 同源。

### 7. Wrong vs Correct

#### Wrong

把完整检查挂回 `/health` 本体（阶段 1 的原始规划）：uptime 监控每次探活都触发一次
Telegram API 调用——Telegram 故障被放大为 Worker 探针失败，且消耗 API 配额。

#### Correct

`/health` 纯存活（版本号除外零外部依赖）；`/selfcheck` 显式完整自检（含 Telegram 往返），
供部署验证与排障一次性调用。两者响应形状刻意一致（`{"status","version"[,"failed"]}`），
监控与诊断读法统一。

---

## 相关规范

- [环境与配置](./env-config.md) — 变量清单与容错解析契约（selfcheck 的严格校验与其分工）
- [错误处理](./error-handling.md) — Telegram 三态结果与已消毒概要（checkWebhook 消费）
- [数据库（D1）](./database.md) — schema 同步契约（EXPECTED_TABLES 与迁移联动）
