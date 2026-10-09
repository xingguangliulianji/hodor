/**
 * topics 表 store（阶段 5 M1 新增文件：T36 note 列交付）：
 * findTopicByUser 的 TopicRow 读出（thread_id / title / status /
 * pinned_msg_id / note）+ setTopicNote 写与清（null = 清空）。
 * 文件级隔离 D1，自播种自断言（vitest-pool-workers 契约）。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { findTopicByUser, insertTopic, setTopicNote } from "../src/store/topics";

const BOT_ID = 42;
const USER_ID = 7601;

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await insertTopic(env.HODOR_DB, {
    botId: BOT_ID,
    userId: USER_ID,
    threadId: 900,
    title: "Note",
  });
});

describe("store: findTopicByUser 的 TopicRow 读出（T36 note 列）", () => {
  it("既有行：note 默认 NULL，其余列照常读出；无行 → null", async () => {
    expect(await findTopicByUser(env.HODOR_DB, BOT_ID, USER_ID)).toEqual({
      thread_id: 900,
      title: "Note",
      status: "open",
      pinned_msg_id: null,
      note: null,
    });
    expect(await findTopicByUser(env.HODOR_DB, BOT_ID, 999999999)).toBeNull();
  });

  it("setTopicNote 写入后随行读出（置顶「备注」行的数据源）", async () => {
    await setTopicNote(env.HODOR_DB, BOT_ID, USER_ID, "仅咨询退款");
    expect((await findTopicByUser(env.HODOR_DB, BOT_ID, USER_ID))!.note).toBe("仅咨询退款");
  });

  it("setTopicNote(null) 清空（/unnote）；覆写为任意新值（/note 重写）", async () => {
    await setTopicNote(env.HODOR_DB, BOT_ID, USER_ID, "改成别的备注");
    expect((await findTopicByUser(env.HODOR_DB, BOT_ID, USER_ID))!.note).toBe("改成别的备注");

    await setTopicNote(env.HODOR_DB, BOT_ID, USER_ID, null);
    expect((await findTopicByUser(env.HODOR_DB, BOT_ID, USER_ID))!.note).toBeNull();
  });

  it("setTopicNote 只动 note：status / pinned_msg_id / title 原样（纯治理信息零副作用）", async () => {
    await env.HODOR_DB.prepare(
      "UPDATE topics SET pinned_msg_id = 500 WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, USER_ID)
      .run();
    await setTopicNote(env.HODOR_DB, BOT_ID, USER_ID, "备注不动其他列");
    const row = await findTopicByUser(env.HODOR_DB, BOT_ID, USER_ID);
    expect(row).toEqual({
      thread_id: 900,
      title: "Note",
      status: "open",
      pinned_msg_id: 500,
      note: "备注不动其他列",
    });
  });
});
