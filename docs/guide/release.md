# 发布与更新

代码从 GitHub 到线上 Worker 的路径，与消息链路相互独立。本页同时覆盖两条线：维护者如何发布新版本，fork 用户如何跟随更新。

## 发布流水线

```
维护者 push main ──┬─→ GitHub Actions（release-please）：
                   │     自动维护「Release PR」= 版本号 bump + CHANGELOG
                   └─→ CF Workers Builds：立即构建部署，代码上线
                        （/health 版本号待 Release PR 合并后才更新）

合并 Release PR ───┬─→ Actions：自动打 tag vX.Y.Z + 发布 GitHub Release
                   └─→ main 版本号变更 → CF 再次构建部署，版本号生效
```

## 版本管理

版本号唯一记录在 `package.json` 的 `version` 字段，由 **Release Please**（GitHub Actions）自动维护——任何人都不需要手动改版本号。

### 发布新版本（维护者）

1. 正常开发提交，commit message 使用约定式格式：`feat:` 新功能（升 MINOR）、`fix:` 修复（升 PATCH）、标注 `BREAKING CHANGE` 的提交升 MAJOR
2. push 到 main 后，release-please 自动开出（或更新）一个 **Release PR**，内容为版本号 bump + CHANGELOG
3. 此时 CF 已用最新代码完成部署（**代码先上线**）；合并 Release PR 即完成发布：
   - Actions 自动打 tag `vX.Y.Z`、发布 GitHub Release（正文即 changelog）
   - main 版本号变更再次触发 CF 部署，`/health` 显示新版本

::: tip
代码上线与版本号生效是两次部署：可以攒若干 feature 后再合并 Release PR 集中发版；窗口期内 `/health` 显示的仍是上一个已发布的版本号，属正常现象。
:::

### 跟随更新（fork 用户）

部署实例默认**手动**跟随官方更新，官方发版**不会自动波及任何用户实例**：

1. 收到官方 Release 通知（在官方仓库点 **Watch → Releases** 可订阅发版通知）
2. 打开自己 fork 的 GitHub 页面，点 **Sync fork**（无需终端；或命令行 `git fetch upstream && git merge upstream/main && git push`）
3. 自己的 Cloudflare 随即自动构建、执行数据库迁移并部署
4. 访问 `/selfcheck` 复查自检全绿、`/health` 版本号已更新

## 发布回归清单

阶段 7 起每次发版的固定检查面（维护者执行）：

**发版前（合并 Release PR 前）**

- `npm test` 全绿——包含发布回归套件 `test/release-regression.test.ts`（端点鉴权 / 入站 / 出站 / 幂等 / 命令 / 限频 / 防毒丸 / 版本一致共 9 个部署链路顺序场景）
- `npm run typecheck` 通过

**发版后（部署完成、版本号生效后）**

- `curl https://<worker-url>/health` 返回 ok，且 `version` == 本次 Release tag（如 `v1.2.0`）
- `curl https://<worker-url>/selfcheck` 全绿返回 `{"status":"ok","version":"…"}`，且 `version` 与 `/health` 一致

## 相关页面

- [部署流程](./deploy.md)
- [本地开发](./development.md)
- [运维手册](./ops.md)
