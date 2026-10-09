# 数据库（D1）规范

> hodor 的 D1 schema、迁移与文档同步约定。
> 字段与语义的**唯一事实源**是 `docs/guide/database.md`（`migrations/0001_init.sql` 头部已引用）。

---

## 场景：表结构改动（强制文档同步）

### 1. 范围 / 触发

以下任何一项改动都必须走本规范：

- 新建 / 删除表
- 字段增删改（名称、类型、默认值、NOT NULL）
- 索引、PRIMARY KEY、UNIQUE 约束、CHECK 枚举值
- 字段语义变化（状态枚举取值、谁写入、何时清理）

### 2. 同步契约

一次表结构改动必须**同一提交**内落地两处，缺一不可：

| 产物 | 路径 | 职责 |
|------|------|------|
| 迁移 SQL | `migrations/NNNN_*.sql` | 可执行 DDL。幂等由 wrangler migrations 台账保证：不写 `IF NOT EXISTS`，不写任何 DROP / 破坏性语句 |
| 表文档 | `docs/guide/database.md` | 字段与语义唯一事实源：类型、说明、索引、全局约定 |

阶段 7 起追加第三处同步面：`scripts/d1-console.sql`（D1 Console 运维查询包）引用全部表与字段——
涉及**字段增删改 / 表语义变化**时，同一提交核对受影响的查询段（含 `docs/guide/ops.md`「常用 SQL」
精选条目，其 SQL 与本文件逐字一致）；新增表时在孤儿检测 / 总览段评估是否需要补查询。

迁移文件头部必须保留对事实源的引用：

```sql
-- 字段与语义唯一事实源：docs/guide/database.md
```

全局约定（新表同样适用）：所有表带 `bot_id` 维度；时间戳 ISO-8601 UTC 文本；布尔用 `0`/`1` 整数；不建外键（D1 默认不启用 FK enforcement，表间关系仅为逻辑关系）。

### 3. 提交前同步检查清单

- [ ] 文档中该表的字段清单与 DDL 逐字段一致（名称 / 类型 / 默认值）
- [ ] 索引、PK、UNIQUE 约束在文档中体现（表头说明或「索引」行）
- [ ] CHECK 枚举值与文档列出的取值一致
- [ ] 字段语义说明（写入时机、清理时机）随语义同步更新
- [ ] 「表间关系」图仍成立
- [ ] `scripts/d1-console.sql` 受影响查询段已核对（字段名 / 表名与 DDL 一致）
- [ ] 依赖 schema 的测试随迁移更新（测试基座直接注入 `migrations/`，见 [测试基座](./testing.md)）

### 4. Good / Base / Bad

- **Good**：迁移与 `docs/guide/database.md` 同一提交，diff 逐项对应
- **Base**：纯文档勘误（不改 DDL）允许单独提交
- **Bad**：先合迁移、文档「以后再补」——文档一旦漂移，后续会话会把过时 schema 当事实源，错误随之扩散

### 5. Wrong vs Correct

#### Wrong

新增字段只写了迁移：

```sql
ALTER TABLE users ADD COLUMN muted_until TEXT;
```

`docs/guide/database.md` 的 users 表没有该行 → 下个会话按文档设计时字段被忽略，或语义被重新发明。

#### Correct

同一提交内迁移与文档各一份：

```sql
ALTER TABLE users ADD COLUMN muted_until TEXT;
```

```markdown
| `muted_until` | TEXT | 禁言截止时间（`/ban` 写入，到期自动解禁） |
```

---

## 场景：运行时开关（settings 表，阶段 5 确立）

### 1. 范围 / 触发

需要**命令即时切换、重部署不丢失**的行为开关（如验证开关 `verify_enabled`、
验证模式 `verify_mode`）。部署级配置仍走 env（见 [环境与配置](./env-config.md)）。

### 2. 契约

- **默认值 = 该功能交付前的既有行为**：行缺失 / 值非法一律回退默认
  （`verify_enabled=1`、`verify_mode=math`）——存量部署零迁移零感知。
- 读取每消息一次、**不做缓存**：「命令切换即时生效」是产品语义，缓存引入失效窗口。
- 写入用 `INSERT ... ON CONFLICT(key) DO UPDATE`（UPSERT 幂等，重复执行无害）。
- **settings 现无 bot_id 维度**（单 bot 主线）；阶段 8 多 bot 需维度拆分——
  在此之前不得往 settings 写任何按 bot / 按用户区分的状态（按用户状态属于
  users / topics 行，如时间窗列用原子认领 UPDATE，见 error-handling 频控契约）。
- 加列迁移先例（0002/0003）：只允许 `ALTER TABLE ... ADD COLUMN` 增量变更，
  向后兼容、无破坏语句；文档同步契约照常同提交执行。

### 3. Wrong vs Correct

- **Wrong**：新开关存 env（切换要重部署）；或把按用户的时间窗状态塞进
  settings（`risk_notice:<uid>` 之类无界键）。
- **Correct**：全局开关 → settings 键值 + 默认回退；按用户状态 → users 行列 +
  原子认领 UPDATE。

---

## 相关规范

- [环境与配置](./env-config.md) — D1 绑定 `HODOR_DB` 与 database_id 占位符约定
- [测试基座](./testing.md) — `readD1Migrations` 注入、按测试文件粒度应用迁移
