/**
 * bots 表 store：upsertBot 保留 created_at（首次绑定时间）+
 * getSingleBotId 空表 → null。文件级隔离 D1，自播种自断言。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { getSingleBotId, upsertBot } from "../src/store/bots";

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
});

describe("store: bots", () => {
  it("空表 → getSingleBotId 返回 null", async () => {
    expect(await getSingleBotId(env.HODOR_DB)).toBeNull();
  });

  it("upsertBot：新建后可读取", async () => {
    await upsertBot(env.HODOR_DB, { botId: 42, username: "hodor_bot", displayName: "hodor" });
    expect(await getSingleBotId(env.HODOR_DB)).toBe(42);
  });

  it("upsertBot：再绑定刷新 username / display_name，created_at（首次绑定时间）保留", async () => {
    const first = await env.HODOR_DB.prepare(
      "SELECT username, display_name, created_at FROM bots WHERE bot_id = 42",
    ).first<{ username: string; display_name: string; created_at: string }>();

    // 稍等毫秒级时钟推进，确保若实现误改 created_at，新值必然不同
    await new Promise((resolve) => setTimeout(resolve, 5));
    await upsertBot(env.HODOR_DB, {
      botId: 42,
      username: "hodor_bot_v2",
      displayName: "hodor v2",
    });

    const second = await env.HODOR_DB.prepare(
      "SELECT username, display_name, created_at FROM bots WHERE bot_id = 42",
    ).first<{ username: string; display_name: string; created_at: string }>();
    expect(second).toEqual({
      username: "hodor_bot_v2",
      display_name: "hodor v2",
      created_at: first!.created_at, // 不随再绑定漂移
    });
  });
});
