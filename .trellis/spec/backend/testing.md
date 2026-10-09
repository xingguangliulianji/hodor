# 测试基座(vitest-pool-workers 0.22 + Vitest 4)

> Worker 测试基架如何接线。S1(2026-09-28)确立。

---

## 场景:新增或运行 Worker 测试

### 1. 范围 / 触发条件

任何需要 `SELF.fetch`、D1 绑定或 `cloudflare:test` 导入的 `test/*.test.ts`。

### 2. 签名

```ts
// vitest.config.ts —— 必须同时使用两个钩子(0.22 API;defineWorkersConfig 已被移除):
import { defineConfig } from 'vitest/config';
import { cloudflarePool, cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL('./migrations/', import.meta.url).pathname);
  const workers = {
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
  };
  return {
    plugins: [cloudflareTest(workers)],
    test: {
      pool: 'cloudflare-pool',                 // 必须等于 cloudflarePool(...) 的 .name
      poolRunner: cloudflarePool(workers),
    },
  };
});
```

```ts
// test/*.test.ts —— 迁移按测试文件粒度应用到彼此隔离的本地 D1
import { applyD1Migrations, env } from 'cloudflare:test';

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  // 播种父行(bots → users → …)—— D1 不强制 FK,父子关系只是逻辑上的
});
```

### 3. 契约

- 版本配对是严格的:`@cloudflare/vitest-pool-workers@0.22.x` 对等依赖 `vitest@^4.1.0`。
  Vitest 5.x 会报 `Missing "./config" specifier`。
- `test/cloudflare-test-env.d.ts` 把 `TEST_MIGRATIONS: D1Migration[]` 合并进
  `Cloudflare.Env`;tsconfig 的 `types` 必须是 `["@cloudflare/vitest-pool-workers/types"]`
  (自 0.22 起 `cloudflare:test` 环境模块位于该子路径导出中),并且生成的
  `worker-configuration.d.ts` 要包含在 `include` 里。
- **影响行为的 env 变量必须在 `vitest.config.ts` 的 `miniflare.bindings` 钉死
  为默认值**(先例:`MAX_MESSAGES_PER_MINUTE`、`VERIFY_TTL_HOURS`):测试基座会
  读到本机 `.dev.vars`,真机调试临时改值会静默破坏无关用例的确定性
  (如 TTL=1 让已验证种子用户凭空触发重验)。

### 4. 校验与错误矩阵

- `compatibility_date` 晚于内置 workerd 支持的日期 → 启动报错
  `This Worker requires compatibility date …`。固定为 workerd 上限(当前 `2026-08-22`)。
- 测试内使用 `node:fs`(workerd 沙箱)→ `no such file or directory`。在 Node 侧读文件
  (`readD1Migrations`、配置),再通过绑定注入。
- Pool 名称不匹配(`test.pool` ≠ `cloudflare-pool`)→ `Runner … is not supported`。

### 5. 正例 / 基线 / 反例

- **正例**:新测试文件在 `beforeAll` 中应用迁移,只播种自己需要的 FK 父行。
- **基线**:测试只涉及路由 → 用 wrangler.jsonc 的 `main`,以 `SELF.fetch` 调用。
- **反例**:跨测试文件共享被修改过的 DB 状态(存储按文件隔离——依赖这一点,每个文件
  重新播种),或手写第二个迁移执行器。

### 6. 必需测试

- 任何涉及 schema 的改动(S2 起)必须在同一任务内更新 `test/schema.test.ts` 的断言。
- 数据层规则(docs/10):唯一索引冲突用 `INSERT … ON CONFLICT DO NOTHING` +
  `meta.changes` 判断;CHECK 约束拒绝非法状态值。

### 7. 反例 vs 正例

#### 反例

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'; // 该导出在 0.22 中已移除
```

#### 正例

```ts
import { cloudflarePool, cloudflareTest } from '@cloudflare/vitest-pool-workers';
export default defineConfig({
  plugins: [cloudflareTest(workers)],
  test: { pool: 'cloudflare-pool', poolRunner: cloudflarePool(workers) },
});
```

**原因**:0.22 围绕 Vitest 4 的自定义 pool 协议重构了整个包;插件提供 `cloudflare:test`
虚拟模块,poolRunner 注册运行时。
