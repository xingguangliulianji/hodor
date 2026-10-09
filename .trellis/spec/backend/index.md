# 后端开发规范

> hodor Worker(Cloudflare Workers + D1 + Telegram)的项目专属约定。

---

## 规范索引

| 规范 | 说明 | 状态 |
|------|------|------|
| [环境与配置](./env-config.md) | 环境绑定、`.dev.vars` 单点配置、`Cloudflare.Env` 合并 | 已填写(S1) |
| [错误处理](./error-handling.md) | Telegram 三态结果语言、分类矩阵、消费方规则 | 已填写(S2) |
| [测试基座](./testing.md) | vitest-pool-workers 0.22 + Vitest 4 接线方式、迁移注入 | 已填写(S1) |
| [数据库(D1)](./database.md) | 表结构改动与 `docs/guide/database.md` 的强制同步契约 | 已填写(S1) |
| [观测端点](./observability.md) | `/health` 存活探针与 `/selfcheck` 完整自检的双端点契约、严格校验与容错解析分工 | 已填写(S7) |

新约定确立后,在此追加新的规范文件(每个主题一个文件,并从本表链接)。
跨层思维检查清单见 [../guides/index.md](../guides/index.md)。

---

**语言**:所有文档一律使用**中文**撰写。
