/**
 * 账本写失败分支（trellis-check P2 加固，2026-09-30）——直接覆盖 webhook
 * 「部分成功窗口」的账本分支（design.md §二失败表第 7 行：账本 retryable →
 * 抛 → 重推）：中继已成功送达、insertMessage 失败 → handleInbound rejects →
 * webhook 500、processed_updates **保持 processing**，绝不提前 markProcessed
 * 掩盖失败（p1.md 警示；重推会重发一次中继 = at-least-once 已知代价）。
 *
 * D1 故障注入：迁移后 DROP TABLE messages——此后任何 messages 写入即抛
 * 「no such table」，等价于该次账本写失败。vitest-pool-workers 按测试文件
 * 隔离 D1（.trellis/spec/backend/testing.md），本文件的破坏不影响其他文件；
 * 单独成文件正因 DROP 会污染同文件的其他用例。
 *
 * 阶段 4 前置播种（2026-09-30）：三门交付后中继 / 账本仅已验证用户可达——
 * 本用例的用户 7400 在 beforeAll 直插 is_verified=1（等同先走完验证门），
 * 使消息直达「置顶 → 中继 → 账本」链；断言与账本失败契约不变。
 *
 * 经 SELF.fetch 走完整 worker 入口（鉴权 → 认领 → inbound 全链），
 * Telegram 出站经 telegramFetchStub 拦截，无真实网络。
 */
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertBot } from "../src/store/bots";
import { stubTelegramFetch, type TelegramFetchStub } from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const SUPPORT_CHAT_ID = -1001234567890;

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
  // 阶段 4 播种：已验证用户（文件头说明）——先于 DROP TABLE messages
  await env.HODOR_DB.prepare(
    `INSERT INTO users (bot_id, user_id, first_name, username, is_verified, verified_at, first_seen_at, last_seen_at)
     VALUES (?, 7400, 'Ledger', 'ledger_hd', 1, '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z')`,
  )
    .bind(BOT_ID)
    .run();
  // 唯一故障注入点：messages 表不可写（该次 insertMessage 必抛）
  await env.HODOR_DB.prepare("DROP TABLE messages").run();
});

describe("webhook: 中继成功后账本写失败（部分成功窗口的账本分支）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("insertMessage 抛 → 500、行保持 processing(attempts=0)，不提前 markProcessed；中继确已发出", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 500 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });

    const res = await SELF.fetch("https://example.com/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 9200,
        message: {
          message_id: 10,
          from: { id: 7400, first_name: "Ledger", username: "ledger_hd" },
          chat: { id: 7400, type: "private" },
          text: "账本写失败的这条",
          date: 1700000000,
        },
      }),
    });
    expect(res.status).toBe(500);

    // 中继确实已送达（到账本前一步全成功：置顶 + 中继恰各一次——已验证
    // 存量用户非 start 无欢迎语，见文件头阶段 4 播种说明）
    const relay = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).text === "账本写失败的这条");
    expect(relay).toHaveLength(1);
    expect(relay[0].body).toMatchObject({ chat_id: SUPPORT_CHAT_ID, message_thread_id: 500 });

    // 绝不提前标记：行停在 processing(attempts=0)，交由 60s 过期接管重推
    const row = await env.HODOR_DB.prepare(
      "SELECT status, attempts FROM processed_updates WHERE bot_id = ? AND update_id = ?",
    )
      .bind(BOT_ID, 9200)
      .first<{ status: string; attempts: number }>();
    expect(row).toEqual({ status: "processing", attempts: 0 });
  });
});
