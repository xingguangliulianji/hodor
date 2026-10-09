// 测试运行时专属绑定：vitest.config.ts 经 miniflare bindings 注入的迁移内容
// （D1Migration 类型由 tsconfig types 指向的
//  @cloudflare/vitest-pool-workers/types 的 cloudflare:test 模块声明提供）
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }

  // Worker 项目不含 DOM lib，而 vitest.config.ts 在 Node 侧用 import.meta.url
  // 定位 migrations 目录，这里补上该属性的最小类型（lib.dom 中同名声明的等价物）
  interface ImportMeta {
    readonly url: string;
  }
}

export type {};
