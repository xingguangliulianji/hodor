// 七表齐备 + 关键约束生效 + settings 读写冒烟（T04）
// 原则：本阶段尚无 store 层，直接用 env.HODOR_DB 裸 SQL 断言 schema 本身
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

// 每个测试文件对各自的隔离 D1 应用迁移（文件间存储隔离，各自重建）
beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
});

describe("schema: 七表齐备", () => {
  it("sqlite_master 恰好包含七张业务表", async () => {
    const { results } = await env.HODOR_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'" +
        // 排除内部表：sqlite_%（SQLite 内部）、d1_migrations（wrangler 迁移台账）、
        // 下划线开头（D1 本地实现自带的 _cf_METADATA 等）
        " AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'" +
        " AND substr(name, 1, 1) != '_' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((row) => row.name)).toEqual([
      "bots",
      "delete_confirmations",
      "messages",
      "processed_updates",
      "settings",
      "topics",
      "users",
    ]);
  });
});

describe("schema: CHECK 约束", () => {
  it("users.status 非法值被拒绝", async () => {
    await expect(
      env.HODOR_DB.prepare(
        "INSERT INTO users (bot_id, user_id, status) VALUES (1, 100, 'bogus')",
      ).run(),
    ).rejects.toThrow(); // D1 错误以 rejected promise 形式抛出
  });
});

describe("schema: topics 双向唯一", () => {
  it("(bot_id, thread_id) 重复插入被拒；同 user 换 thread 更新成功", async () => {
    await env.HODOR_DB.prepare(
      "INSERT INTO topics (bot_id, user_id, thread_id) VALUES (1, 100, 500)",
    ).run();

    // 不同 user 复用同 (bot_id, thread_id) → UNIQUE 索引拒绝
    await expect(
      env.HODOR_DB.prepare(
        "INSERT INTO topics (bot_id, user_id, thread_id) VALUES (1, 200, 500)",
      ).run(),
    ).rejects.toThrow();

    // 同 user 更新到新 thread → 允许
    await env.HODOR_DB.prepare(
      "UPDATE topics SET thread_id = 501 WHERE bot_id = 1 AND user_id = 100",
    ).run();
    const row = await env.HODOR_DB.prepare(
      "SELECT thread_id FROM topics WHERE bot_id = 1 AND user_id = 100",
    ).first<{ thread_id: number }>();
    expect(row?.thread_id).toBe(501);
  });
});

describe("schema: processed_updates 幂等主键", () => {
  it("重复 (bot_id, update_id) 插入被拒", async () => {
    await env.HODOR_DB.prepare(
      "INSERT INTO processed_updates (bot_id, update_id, status) VALUES (1, 9000, 'processed')",
    ).run();
    await expect(
      env.HODOR_DB.prepare(
        "INSERT INTO processed_updates (bot_id, update_id, status) VALUES (1, 9000, 'failed')",
      ).run(),
    ).rejects.toThrow();
  });
});

describe("schema: processed_updates status 三值 CHECK（迁移 0002）", () => {
  it("processing / processed / failed 均可插入；非法值被拒", async () => {
    for (const [i, status] of ["processing", "processed", "failed"].entries()) {
      await env.HODOR_DB.prepare(
        "INSERT INTO processed_updates (bot_id, update_id, status) VALUES (1, ?, ?)",
      )
        .bind(9200 + i, status)
        .run();
    }
    await expect(
      env.HODOR_DB.prepare(
        "INSERT INTO processed_updates (bot_id, update_id, status) VALUES (1, 9999, 'bogus')",
      ).run(),
    ).rejects.toThrow();
  });
});

describe("schema: settings 读写冒烟", () => {
  it("INSERT → UPDATE → SELECT 往返取到更新后的值", async () => {
    await env.HODOR_DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('verify_enabled', '1')",
    ).run();
    await env.HODOR_DB.prepare(
      "UPDATE settings SET value = '0' WHERE key = 'verify_enabled'",
    ).run();
    const row = await env.HODOR_DB.prepare(
      "SELECT value FROM settings WHERE key = 'verify_enabled'",
    ).first<{ value: string }>();
    expect(row?.value).toBe("0");
  });
});
