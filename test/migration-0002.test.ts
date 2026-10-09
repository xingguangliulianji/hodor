/**
 * 迁移 0002（processed_updates 表重建）行为验证：
 * 在只应用 0001 的库上播种既有行 → 应用 0002 → 断言行全字段保留、
 * 新 CHECK 三值生效、其他表不受重建影响。
 * 这是对「INSERT SELECT 保数据 → DROP → RENAME」重建正确性的直接证明
 * （正常测试文件一把应用全部迁移，无法覆盖「带着存量数据做重建」的场景）。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  // ① 只应用 0001（旧 schema：status 仅 processed/failed）
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS.slice(0, 1));

  // ② 旧 schema 下播种两行终态数据（0001 CHECK 只允许这两种值）+ 一行 bots
  await env.HODOR_DB.prepare(
    "INSERT INTO processed_updates (bot_id, update_id, status, attempts, created_at)" +
      " VALUES (42, 9001, 'processed', 0, '2026-09-29T10:00:00.000Z')," +
      "        (42, 9002, 'failed', 3, '2026-09-29T11:30:45.123Z')",
  ).run();
  await env.HODOR_DB.prepare(
    "INSERT INTO bots (bot_id, username, display_name) VALUES (7, 'seed_bot', 'Seed')",
  ).run();

  // ③ 应用 0002（表重建）
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS.slice(1, 2));
});

describe("迁移 0002：表重建保数据", () => {
  it("旧 schema 的行全字段原样保留", async () => {
    const { results } = await env.HODOR_DB.prepare(
      "SELECT bot_id, update_id, status, attempts, created_at FROM processed_updates" +
        " ORDER BY update_id",
    ).all<{
      bot_id: number;
      update_id: number;
      status: string;
      attempts: number;
      created_at: string;
    }>();
    expect(results).toEqual([
      {
        bot_id: 42,
        update_id: 9001,
        status: "processed",
        attempts: 0,
        created_at: "2026-09-29T10:00:00.000Z",
      },
      {
        bot_id: 42,
        update_id: 9002,
        status: "failed",
        attempts: 3,
        created_at: "2026-09-29T11:30:45.123Z",
      },
    ]);
  });

  it("重建只影响 processed_updates：bots 行不受波及", async () => {
    const bot = await env.HODOR_DB.prepare(
      "SELECT bot_id, username, display_name FROM bots",
    ).first<{ bot_id: number; username: string; display_name: string }>();
    expect(bot).toEqual({ bot_id: 7, username: "seed_bot", display_name: "Seed" });
  });

  it("新 CHECK：'processing' 可插入，非法值仍被拒", async () => {
    await env.HODOR_DB.prepare(
      "INSERT INTO processed_updates (bot_id, update_id, status) VALUES (42, 9100, 'processing')",
    ).run();
    await expect(
      env.HODOR_DB.prepare(
        "INSERT INTO processed_updates (bot_id, update_id, status) VALUES (42, 9101, 'bogus')",
      ).run(),
    ).rejects.toThrow();
  });

  it("复合主键在重建后依然生效", async () => {
    await expect(
      env.HODOR_DB.prepare(
        "INSERT INTO processed_updates (bot_id, update_id, status) VALUES (42, 9001, 'failed')",
      ).run(),
    ).rejects.toThrow();
  });
});
