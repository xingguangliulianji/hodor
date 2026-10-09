# 环境与配置契约

> hodor 如何接线环境绑定与机密。S1(2026-09-28)确立;变量表已对齐 docs/guide/deploy.md
> 的 9 变量契约(2026-09-30 增补 WELCOME_TEXT)。

---

## 场景:读取任意 Worker 环境绑定

### 1. 范围 / 触发条件

只要代码在 Worker 内读取 `env.*`、新增变量,或改动 `wrangler.jsonc` / `.dev.vars*`,
本规范即适用。配置值以本文为单一事实来源。

### 2. 签名

```ts
// src/types.ts —— src/ 中 Env 的唯一导入点
export type Env = Cloudflare.Env;

// src/env.d.ts —— 手工维护的合并,覆盖无法从 wrangler.jsonc 推导的变量
declare global {
  namespace Cloudflare {
    interface Env {
      TELEGRAM_BOT_TOKEN: string;        // 必填 Secret
      TELEGRAM_WEBHOOK_SECRET: string;   // 必填 Secret
      ADMIN_SECRET: string;              // 必填 Secret
      SUPPORT_CHAT_ID: string;           // 必填 Var
      ADMIN_IDS: string;                 // 必填 Var(逗号分隔)
      MAX_MESSAGES_PER_MINUTE?: string;  // 可选 Var,默认 20
      VERIFY_TTL_HOURS?: string;         // 可选 Var,默认 0(永久)
      MAX_ATTEMPTS?: string;             // 可选 Var,默认 3
      WELCOME_TEXT?: string;             // 可选 Var,缺省用内置默认欢迎语(src/copy.ts)
    }
  }
}

// worker-configuration.d.ts —— 由 `npx wrangler types` 生成。只包含 HODOR_DB 绑定,
// 不含其他内容(仓库配置未声明任何 [vars])。wrangler.jsonc 变更后重新生成并提交该文件。
// 生成前必须先把 .dev.vars 移开 —— 见下方错误矩阵。
```

### 3. 契约

| 键 | 类型 | 本地来源 | 远程来源 | 默认语义(代码侧) |
|-----|------|----------|----------|--------------------|
| `HODOR_DB` | D1Database | wrangler.jsonc | wrangler.jsonc | — |
| `TELEGRAM_BOT_TOKEN` | string | `.dev.vars` | 控制台「变量和机密」/ `wrangler secret put` | 必填 |
| `TELEGRAM_WEBHOOK_SECRET` | string | `.dev.vars` | 控制台「变量和机密」/ `wrangler secret put` | 必填 |
| `ADMIN_SECRET` | string | `.dev.vars` | 控制台「变量和机密」/ `wrangler secret put` | 必填 |
| `SUPPORT_CHAT_ID` | string | `.dev.vars` | 控制台「变量和机密」 | 必填 |
| `ADMIN_IDS` | string(逗号分隔) | `.dev.vars` | 控制台「变量和机密」 | 空 = 无管理员 |
| `MAX_MESSAGES_PER_MINUTE` | string | `.dev.vars` | 控制台「变量和机密」 | 可选;缺失/非法 → `20` |
| `VERIFY_TTL_HOURS` | string | `.dev.vars` | 控制台「变量和机密」 | 可选;缺失/非法 → `0`(永久) |
| `MAX_ATTEMPTS` | string | `.dev.vars` | 控制台「变量和机密」 | 可选;缺失/非法 → `3` |
| `WELCOME_TEXT` | string | `.dev.vars` | 控制台「变量和机密」 | 可选;缺失/空白 → 内置默认欢迎语(`src/copy.ts` `DEFAULT_WELCOME_TEXT`);字面 `\n` 解释为换行(真实换行原样保留) |

`.dev.vars.example` 是带注释的本地模板(每个变量:一条注释 + 一行**注释掉的**赋值 + 一个空行)。
模板条目默认全部注释是**有意设计**(2026-10-09 用户决策),一职两用:(a) Deploy 按钮 / Workers
导入向导按本文件生成变量表单——未注释条目 = 必填密文输入框,注释条目被跳过;全部注释 = 部署
零变量提示,所有变量部署后在面板「变量和机密」配置、`/selfcheck` 逐项核对。(b) 本地开发模板:
`cp` 后逐行取消注释填值(必填 5 条必须启用)。**禁止**把每实例不同的变量值放进 wrangler 配置
`vars` 块换取明文展示——config 声明的 vars 会在每次部署时覆盖面板值(workers-sdk #4453/#276),
把面板真值打回仓库占位符。
远程值在控制台(Worker → Settings → 变量和机密)配置**一次**即可——绝不进仓库。拆分规则
(已对照官方文档 + 2026-09-28 生产验证):`wrangler deploy` 会把控制台绑定重置为与配置文件
一致,但 wrangler.jsonc 中的 `keep_vars: true` 会保留控制台 Text 变量;而且无论哪种情况,
部署都不会删除机密(secrets)。仓库不携带任何变量值 → fork 用户无需修改仓库中的任何东西。

### 4. 校验与错误矩阵

- 运行时机密缺失 → 绑定为 `undefined`;在需要它的调用点快速失败(不得带着空凭据静默继续)。
- `MAX_ATTEMPTS` / `MAX_MESSAGES_PER_MINUTE` 不是正整数 → 回退为 `3` / `20`(先解析,
  不轻信输入)。`VERIFY_TTL_HOURS` 为负 → `0`。
- `WELCOME_TEXT` 缺失 / trim 后为空 → 使用内置默认欢迎语(`src/copy.ts`),空串不当
  自定义文案;有效值中字面 `\n` 解释为换行,真实换行原样保留。
- 本地存在 `.dev.vars` 时重新生成类型,会把其中的键泄漏进提交的 `worker-configuration.d.ts`,
  变成必填的 `Cloudflare.Env` 绑定(2026-09-30 实测:一份过期的 `.dev.vars` 把已删除的
  `ALLOW_UNKNOWN_USERS` 泄漏了进来)。执行 `wrangler types` 前先把 `.dev.vars` 移开;
  提交的文件必须只包含 wrangler.jsonc 声明的绑定。

### 5. 正例 / 基线 / 反例

- **正例**:新增变量 → 写入 `.dev.vars.example` → 在 `src/env.d.ts` 加类型 → 通过 `env.<KEY>` 读取。
- **基线**:本地缺失该变量 → 代码默认值生效,单元测试覆盖默认分支。
- **反例**:把值硬编码进 `wrangler.jsonc` 的 `[vars]`、某个提交文件,或 src/ 中的内联字面量。

### 6. 必需测试

- `test/health.test.ts` 断言精确的响应形状——防止配置泄漏到输出。
- S2 起:默认语义分支(`MAX_ATTEMPTS`)需要显式单元测试。

### 7. 反例 vs 正例

#### 反例

// 提交的配置中没有 keep_vars 时,控制台 Text 变量
→ 每次 `wrangler deploy` 都被清空(默认 --keep-vars=false 会把绑定重置为与配置一致;
2026-09-28 生产实测)

#### 正例

```jsonc
// wrangler.jsonc —— 由维护者提交一次;部署者永远不需要改仓库
"keep_vars": true,
```

```
# 远程:控制台 Worker → Settings → 变量和机密 —— 全部 8 个值,配置一次,持久保留
# 本地:.dev.vars(git 忽略)—— 同样这 8 个键,供 wrangler dev 使用
```

**原因**:有 `keep_vars: true` 时,控制台变量(Text 或 Secret)在每次部署后都保留;
且机密在任何情况下都不会被部署删除(官方文档)。`Cloudflare.Env` 仍是唯一的类型化契约
(`env.d.ts` 的合并补充生成器无法知晓的部分)。

## 约定:D1 database_id 在仓库中永久保持占位符

**内容**:`wrangler.jsonc` 永久保留 `database_id: "00000000-0000-0000-0000-000000000000"`。
真实 id 由 `scripts/deploy.mjs` 在部署时解析(2026-09-30 已随 T05/T06 提前交付,单命令
`npm run deploy` = 解析/创建 D1 → 远端迁移 → 部署):

- 解析顺序:`D1_DATABASE_ID` 环境变量(逃生口,uuid 格式校验)→ `wrangler d1 info hodor
  --json`(存在即复用)→ `wrangler d1 create hodor`(不存在即创建;--json 不支持与
  already-exists 竞态均有回退)。
- 真实 id 只写入 `.wrangler/resolved.wrangler.jsonc`(gitignored),并把 `main` /
  `migrations_dir` 改写为仓库内绝对路径(wrangler 按配置文件所在目录解析相对路径);
  迁移与部署都带 `--config` 指向它,**仓库内的 wrangler.jsonc 一字不改**。
- 迁移失败 → 立即中止且不部署(T06:不发布不兼容代码),重跑 `npm run deploy` 即重试。
- 权限不足(构建 token 无 D1 权限)→ 输出引导:dashboard 建具备 D1 编辑权限的自定义
  token 配到 `CLOUDFLARE_API_TOKEN`,或手动建库后设 `D1_DATABASE_ID`。脚本只记录命令名
  与退出码,不回显任何凭证值。
- **postinstall 钩子按 `WORKERS_CI=1` 门控**(2026-09-30 第三次范围变更):Workers Builds
  官方默认命令(部署 `npx wrangler deploy`、预览 `npx wrangler preview`)零改动可用——
  构建的 install 步骤触发 `node scripts/deploy.mjs --install-hook`:门控命中时执行
  解析/建库 → **就地注入**真实 id 到构建工作区的仓库 wrangler.jsonc(一次性克隆,git
  仓库不受影响;重复执行幂等)→ 版本模块 → 远端迁移(失败 exit 1 → 安装失败 → 构建
  中止,不部署不兼容代码),随后默认部署命令直接读到已注入的配置。门控未命中(本地、
  GitHub Actions 等仅 `CI=true` 环境)→ 一行提示、零写入零网络。判定函数
  `shouldRunInstallHook(env)` 在 `scripts/lib/config.mjs`(纯函数,有单测)。

**原因**:基于 fork 的部署绝不能携带所有者的数据库 id;在配置文件里手工改资源 id 不是
业界做法(见 README「与业界做法的对照」)。不用 postinstall 是为了避免本地安装产生
账号副作用,并让 CI/本地行为完全一致。

**相关**:`npm run deploy`(全流程)、`npm run provision`(--provision-only,只解析+写
resolved 配置)、`npm run db:migrate:remote`(--migrate-only)。纯函数与测试见
`scripts/lib/config.mjs` + `test/deploy-config.test.ts`(JSONC 剥注释/占位符替换,workerd
沙箱可导入)。版本注入(T08)同模式:`scripts/lib/version.mjs` + `src/generated/`
(gitignored,pre* 钩子与 deploy.mjs 生成)。
