/**
 * 出站管线集成（T21 + T22 / T25 / T26，design.md「出站管线」canonical order）：
 * 管理员在映射 topic 发言（文本/媒体）→ relayContent 到用户私聊（不带 thread）
 * + 账本 out 行双 ID；非管理员 / 支持集之外 → 静默零调用；
 * 未映射 / closed thread → T26 提示恰发到该 thread（permanent → warn、
 * retryable → 抛）；中继 permanent → 不写账本。
 * ADMIN_IDS = "111111111,222222222"（vitest.config.ts）。
 *
 * 阶段 3 调整说明：阶段 2 的「未映射 / closed → 静默」用例按 T26 改为
 * 「发送无绑定提示」；「photo 非文本 → 静默」用例改用 video_note（photo
 * 已属支持集会真实中继；audio 亦于 2026-09-30 纳入支持集）——原断言意图
 * 均保留并按新语义收紧。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NOT_ADMIN_COMMAND_NOTICE, UNBOUND_TOPIC_NOTICE } from "../src/copy";
import { handleOutbound } from "../src/pipeline/outbound";
import type { TelegramMessageRef } from "../src/pipeline/classify";
import { upsertBot } from "../src/store/bots";
import { stubTelegramFetch, type TelegramFetchStub } from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const SUPPORT_CHAT_ID = -1001234567890;
const ADMIN_ID = 111111111;

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
});

/** 客服群 topic 内的文本 message 构造 */
function supportThreadMessage(
  fromId: number,
  threadId: number,
  text: string | undefined = "回复",
  messageId = 60,
): TelegramMessageRef {
  return {
    message_id: messageId,
    from: { id: fromId, first_name: "Admin" },
    chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
    text,
    message_thread_id: threadId,
  };
}

/** 客服群 topic 内的媒体 message 构造（content 直接展开，无 text 字段） */
function supportContentMessage(
  fromId: number,
  threadId: number,
  content: Record<string, unknown>,
  messageId: number,
): TelegramMessageRef {
  return {
    message_id: messageId,
    from: { id: fromId, first_name: "Admin" },
    chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
    message_thread_id: threadId,
    ...content,
  } as TelegramMessageRef;
}

/** 直接播种一条映射行（绕过入站管线，聚焦出站逻辑） */
async function seedTopic(userId: number, threadId: number, status = "open"): Promise<void> {
  await env.HODOR_DB.prepare(
    "INSERT INTO topics (bot_id, user_id, thread_id, title, status) VALUES (?, ?, ?, 'seed', ?)",
  )
    .bind(BOT_ID, userId, threadId, status)
    .run();
}

interface MessageRow {
  direction: string;
  group_msg_id: number;
  private_msg_id: number;
  content_type: string;
  thread_id: number;
  user_id: number;
}

const readMessagesByUser = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT direction, group_msg_id, private_msg_id, content_type, thread_id, user_id FROM messages WHERE bot_id = ? AND user_id = ? ORDER BY id",
  )
    .bind(BOT_ID, userId)
    .all<MessageRow>()
    .then((r) => r.results);

describe("outbound: 文本中继与账本", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("管理员在映射 topic 发言 → sendMessage 到用户私聊（不带 message_thread_id）+ 账本 out 行双 ID", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 900 } } });
    await seedTopic(7201, 600);

    await handleOutbound(env, BOT_ID, supportThreadMessage(ADMIN_ID, 600, "请稍等", 61));

    expect(stub.countOf("sendMessage")).toBe(1);
    // 精确键集：出站私聊**不带** message_thread_id
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: 7201,
      text: "请稍等",
    });
    // 账本（T25）：out 行 group = 管理员原始 message_id（完整，供 /purgemsg），
    // private = 私聊中继消息 ID；逐项断言
    const messages = await readMessagesByUser(7201);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      direction: "out",
      group_msg_id: 61,
      private_msg_id: 900,
      content_type: "text",
      thread_id: 600,
      user_id: 7201,
    });
  });

  it("非管理员发言 → 静默完成，零中继、零账本", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    await seedTopic(7202, 601);

    await handleOutbound(env, BOT_ID, supportThreadMessage(999999999, 601));

    expect(stub.countOf("sendMessage")).toBe(0);
    expect(await readMessagesByUser(7202)).toHaveLength(0);
  });

  it("非管理员 / 命令（真机验收增量）→ 回「仅管理员可用」提示恰发该 thread；零中继、零账本", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    await seedTopic(7207, 607);

    await handleOutbound(env, BOT_ID, supportThreadMessage(999999999, 607, "/ban", 63));

    // 唯一一条 sendMessage = 提示发回该 thread（精确键集），无用户私聊调用
    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: NOT_ADMIN_COMMAND_NOTICE,
      message_thread_id: 607,
    });
    expect(await readMessagesByUser(7207)).toHaveLength(0);
  });
});

describe("outbound: T26 无绑定 topic 提示", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("未映射的 thread：管理员发言 → 提示恰发到该 thread（精确键集），不误发任何用户", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await handleOutbound(env, BOT_ID, supportThreadMessage(ADMIN_ID, 699, "这个 topic 是谁", 70));

    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: UNBOUND_TOPIC_NOTICE,
      message_thread_id: 699,
    });
    // 提示不入账本（该 thread 无归属用户，任何账本行都只能源于此调用）
    const anyRow = await env.HODOR_DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND thread_id = ?",
    )
      .bind(BOT_ID, 699)
      .first<{ n: number }>();
    expect(anyRow!.n).toBe(0);
  });

  it("closed 行的 thread → 视同未绑定，同样收到提示", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    await seedTopic(7203, 602, "closed");

    await handleOutbound(env, BOT_ID, supportThreadMessage(ADMIN_ID, 602));

    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toMatchObject({
      chat_id: SUPPORT_CHAT_ID,
      text: UNBOUND_TOPIC_NOTICE,
      message_thread_id: 602,
    });
    expect(await readMessagesByUser(7203)).toHaveLength(0);
  });

  it("非管理员在无绑定 topic 发言 → 静默完成零调用（提示只对管理员）", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await handleOutbound(env, BOT_ID, supportThreadMessage(999999999, 698));

    expect(stub.countOf("sendMessage")).toBe(0);
  });

  it("提示 retryable（网络错误）→ 抛出（→ webhook 500 重推）", async () => {
    stub.always("sendMessage", { throwError: true });

    await expect(
      handleOutbound(env, BOT_ID, supportThreadMessage(ADMIN_ID, 697)),
    ).rejects.toThrow(/sendMessage/);
  });

  it("提示 permanent（400）→ warn 跳过，静默完成不抛", async () => {
    stub.always("sendMessage", {
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request: message thread not found" },
    });

    await expect(
      handleOutbound(env, BOT_ID, supportThreadMessage(ADMIN_ID, 696)),
    ).resolves.toBeUndefined();
    expect(stub.countOf("sendMessage")).toBe(1);
  });
});

describe("outbound: 媒体中继（T22）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("7 类媒体逐类：对应 sendX 到用户私聊（不带 thread，精确键集）+ 账本 out 行", async () => {
    for (const method of ["sendPhoto", "sendVideo", "sendVoice", "sendAudio", "sendDocument", "sendSticker", "sendAnimation"]) {
      stub.always(method, { status: 200, json: { ok: true, result: { message_id: 902 } } });
    }

    const cases = [
      {
        userId: 7210,
        threadId: 610,
        type: "photo",
        content: {
          photo: [
            { file_id: "out_small", file_unique_id: "u1", width: 320, height: 240 },
            { file_id: "out_big", file_unique_id: "u2", width: 1280, height: 960 },
          ],
          caption: "给用户的图",
        },
        method: "sendPhoto",
        wire: { photo: "out_big", caption: "给用户的图" },
      },
      {
        userId: 7211,
        threadId: 611,
        type: "video",
        content: { video: { file_id: "out_vid" }, caption: "视频" },
        method: "sendVideo",
        wire: { video: "out_vid", caption: "视频" },
      },
      {
        userId: 7212,
        threadId: 612,
        type: "voice",
        content: { voice: { file_id: "out_voice" } },
        method: "sendVoice",
        wire: { voice: "out_voice" },
      },
      {
        userId: 7216,
        threadId: 616,
        type: "audio",
        // 音频（2026-09-30 增补）：file_id + caption，title/performer 忽略
        content: { audio: { file_id: "out_audio", title: "歌名" }, caption: "给用户的音乐" },
        method: "sendAudio",
        wire: { audio: "out_audio", caption: "给用户的音乐" },
      },
      {
        userId: 7213,
        threadId: 613,
        type: "document",
        content: { document: { file_id: "out_doc" }, caption: "文件" },
        method: "sendDocument",
        wire: { document: "out_doc", caption: "文件" },
      },
      {
        userId: 7214,
        threadId: 614,
        type: "sticker",
        content: { sticker: { file_id: "out_stk" }, caption: "不该出现" },
        method: "sendSticker",
        wire: { sticker: "out_stk" },
      },
      {
        userId: 7215,
        threadId: 615,
        type: "animation",
        content: { animation: { file_id: "out_gif" } },
        method: "sendAnimation",
        wire: { animation: "out_gif" },
      },
    ];

    for (const c of cases) {
      await seedTopic(c.userId, c.threadId);
      await handleOutbound(env, BOT_ID, supportContentMessage(ADMIN_ID, c.threadId, c.content, 80));

      // 对应 sendX 恰一次；精确键集 = chat_id + file_id(+caption)，**无 thread**
      expect(stub.countOf(c.method), `method ${c.method}`).toBe(1);
      expect(stub.callsOf(c.method)[0].body, `method ${c.method}`).toEqual({
        chat_id: c.userId,
        ...c.wire,
      });
      // 账本：out 行双 ID（group = 管理员原始 80，private = 中继结果 902）
      const messages = await readMessagesByUser(c.userId);
      expect(messages, `ledger ${c.userId}`).toHaveLength(1);
      expect(messages[0]).toEqual({
        direction: "out",
        group_msg_id: 80,
        private_msg_id: 902,
        content_type: c.type,
        thread_id: c.threadId,
        user_id: c.userId,
      });
    }
    // 纯媒体路径不触发 sendMessage
    expect(stub.countOf("sendMessage")).toBe(0);
  });

  it("支持集之外（video_note，管理员 + 已映射 thread）→ 静默完成零中继", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("sendAudio", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    await seedTopic(7204, 603);

    // audio 已于 2026-09-30 纳入支持集（上方媒体用例覆盖），此处用 video_note
    await handleOutbound(
      env,
      BOT_ID,
      supportContentMessage(ADMIN_ID, 603, { video_note: { file_id: "out_vn", length: 30 } }, 62),
    );

    expect(stub.countOf("sendMessage")).toBe(0);
    expect(stub.countOf("sendAudio")).toBe(0);
    expect(await readMessagesByUser(7204)).toHaveLength(0);
  });
});

describe("outbound: 中继失败语义", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("中继 retryable（网络错误）→ 抛出（→ webhook 500 重推）", async () => {
    stub.always("sendMessage", { throwError: true });
    await seedTopic(7205, 604);

    await expect(
      handleOutbound(env, BOT_ID, supportThreadMessage(ADMIN_ID, 604)),
    ).rejects.toThrow(/sendMessage/);
    expect(await readMessagesByUser(7205)).toHaveLength(0);
  });

  it("中继 permanent（403 bot 被拉黑）→ 静默完成不抛，**不写账本**", async () => {
    stub.always("sendMessage", {
      status: 403,
      json: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
    });
    await seedTopic(7206, 605);

    await expect(
      handleOutbound(env, BOT_ID, supportThreadMessage(ADMIN_ID, 605)),
    ).resolves.toBeUndefined();
    expect(stub.countOf("sendMessage")).toBe(1);
    expect(await readMessagesByUser(7206)).toHaveLength(0);
  });
});
