/**
 * 入站管线集成（T19–T25 + 阶段 4 三门 T27/T28/T29/T35）：
 * 已验证用户全链（建档 + 建 topic + 置顶 ✅ + 中继 + 账本）、复用不重建、
 * closed 重开不重发置顶、昵称变更 editMessageText 刷新、/start 频控与短路、
 * 支持集之外先于一切副作用静默完成、失败语义（置顶/欢迎 retryable 抛出且
 * 中继不重复；中继 permanent 不写账本）、并发首联竞态败方清理；
 * 阶段 4 新增：新用户首联包（欢迎 + 验证题成对）、未验证拦截（零 topic /
 * 零账本，/start 亦如此）、pending 重出 slot 节流、封禁门（先于验证与限频）、
 * 限频门（超限合并消息含 limit 数字 + 置顶降级 ❌ + 跨窗口恢复）。
 *
 * 每个用例独立 userId（文件内 DB 共享）；出站 Telegram 调用全部经
 * telegramFetchStub 拦截（含异步响应器：竞态用例需要在请求中途写 D1），无真实网络。
 *
 * 阶段 4 调整说明（前置条件显式化，原断言意图全部保留）：
 * - 阶段 3 的全链 / topic / 中继 / 账本用例：三门交付后这些链路仅**已验证**
 *   用户可达——各用例先 seedVerifiedUser（is_verified=1）再触发，原「首条消息
 *   即全链」意图由「通过验证后的首条消息全链」承载；
 * - 新用户首条消息的欢迎语断言移入「首联包」用例（欢迎 + 验证题成对、无 topic）；
 * - 全链 sendMessage 计数按移除欢迎语后的链路更新（置顶 + 中继 = 2）；
 * - 置顶验证行按两态契约断言（已验证链路恒 ✅、超限降级 ❌）；
 * - 真机验收修正（2026-09-30，沿用）：/start 不中继、不写账本。
 *
 * 阶段 5 M2 新增：高危 24h 一次性提醒（首条恰一条、24h 内零重复、非高危
 * 零提醒、/start 短路零提醒、提醒 retryable 完全 best-effort 不炸主链）、
 * 置顶治理行接库内真值（4a 新置顶 / 4b 刷新均随 is_risk + topics.note）。
 *
 * 阶段 5 M3 新增（T31/T33）：verifyoff 放行（未验证用户零出题直接中继、
 * 置顶「未启用」、记录保留）、限频语义独立（关闭期间超限仍撤验证 + 重出
 * 题）、verifyon 恢复（已验证不重验 / 未验证回门）、TTL 全边界（=0 永不
 * 重验、恰好 = now−ttl 过期 / 边界内不过期、过期撤验证 + 降级 + 出题 +
 * 丢弃、关闭期间过期不判定、往返重开后按 TTL 判定）。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_WELCOME_TEXT, formatPinnedInfo, formatRiskTopicNotice } from "../src/copy";
import { handleInbound } from "../src/pipeline/inbound";
import type { TelegramMessageRef } from "../src/pipeline/classify";
import { upsertBot } from "../src/store/bots";
import { ensureUser } from "../src/store/users";
import { setVerificationEnabled } from "../src/store/settings";
import { stubTelegramFetch, type TelegramFetchStub, type StubbedCall } from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const SUPPORT_CHAT_ID = -1001234567890; // vitest.config.ts 注入的 SUPPORT_CHAT_ID

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
});

/** 私聊文本 message 构造（text 显式传 undefined 即非文本） */
function privateMessage(
  from: { id: number; first_name?: string; last_name?: string; username?: string },
  text: string | undefined = "你好",
  messageId = 10,
): TelegramMessageRef {
  return { message_id: messageId, from, chat: { id: from.id, type: "private" }, text };
}

/** 私聊媒体 message 构造（content 直接展开——真实媒体消息没有 text 字段） */
function privateContentMessage(
  from: { id: number; first_name?: string; last_name?: string; username?: string },
  content: Record<string, unknown>,
  messageId: number,
): TelegramMessageRef {
  return {
    message_id: messageId,
    from,
    chat: { id: from.id, type: "private" },
    ...content,
  } as TelegramMessageRef;
}

/** 直播种子的已验证用户（阶段 4 前置：消息要走到 topic/中继/账本必须先过验证门） */
async function seedVerifiedUser(
  from: { id: number; first_name?: string; last_name?: string; username?: string },
): Promise<void> {
  await ensureUser(env.HODOR_DB, BOT_ID, from);
  await env.HODOR_DB.prepare(
    "UPDATE users SET is_verified = 1, verified_at = ? WHERE bot_id = ? AND user_id = ?",
  )
    .bind(new Date().toISOString(), BOT_ID, from.id)
    .run();
}

/** 治理列读取（三门断言用；M3 起含 verified_at——TTL 断言） */
interface GovRow {
  is_banned: number;
  is_verified: number;
  verified_at: string | null;
  verify_answer: number | null;
  verify_msg_id: number | null;
  rate_window_start: string | null;
  rate_count: number;
}
const readGov = (userId: number) =>
  env.HODOR_DB.prepare(
    `SELECT is_banned, is_verified, verified_at, verify_answer, verify_msg_id, rate_window_start, rate_count
     FROM users WHERE bot_id = ? AND user_id = ?`,
  )
    .bind(BOT_ID, userId)
    .first<GovRow>();

interface UserRow {
  first_name: string;
  last_name: string;
  username: string;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
}
interface TopicRow {
  thread_id: number;
  title: string;
  status: string;
  closed_at: string | null;
  pinned_msg_id: number | null;
}
interface MessageRow {
  direction: string;
  group_msg_id: number;
  private_msg_id: number;
  content_type: string;
  thread_id: number;
  user_id: number;
}

const readUser = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT first_name, last_name, username, status, first_seen_at, last_seen_at FROM users WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<UserRow>();

const readTopic = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT thread_id, title, status, closed_at, pinned_msg_id FROM topics WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<TopicRow>();

const readMessages = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT direction, group_msg_id, private_msg_id, content_type, thread_id, user_id FROM messages WHERE bot_id = ? AND user_id = ? ORDER BY id",
  )
    .bind(BOT_ID, userId)
    .all<MessageRow>()
    .then((r) => r.results);

/** 某用户私聊收到的欢迎语调用（chat_id = 用户 ID 且 text 匹配；默认比对内置文案） */
function welcomeCalls(
  stub: TelegramFetchStub,
  userId: number,
  text: string = DEFAULT_WELCOME_TEXT,
): StubbedCall[] {
  return stub.callsOf("sendMessage").filter((call) => {
    const body = call.body as Record<string, unknown>;
    return body.chat_id === userId && body.text === text;
  });
}

/** 某用户私聊收到的验证题推送（chat_id = 用户 ID 且携带 inline 键盘） */
function questionCalls(stub: TelegramFetchStub, userId: number): StubbedCall[] {
  return stub.callsOf("sendMessage").filter((call) => {
    const body = call.body as Record<string, unknown>;
    return body.chat_id === userId && body.reply_markup !== undefined;
  });
}

/** 落进客服群 topic 的中继调用（chat_id = 客服群 且 text 匹配） */
function relayCalls(stub: TelegramFetchStub, text: string): StubbedCall[] {
  return stub.callsOf("sendMessage").filter((call) => {
    const body = call.body as Record<string, unknown>;
    return body.chat_id === SUPPORT_CHAT_ID && body.text === text;
  });
}

/** 每个用例的默认桩：置顶 / 编辑调用默认成功（与用例主旨无关时不逐个注册） */
function defaultPinStubs(stub: TelegramFetchStub): void {
  stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });
  stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 1 } } });
}

/** 限频 env 覆盖（其余绑定与 vitest.config.ts 注入值一致） */
function envWithRateLimit(limit: number): Cloudflare.Env {
  return {
    HODOR_DB: env.HODOR_DB,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    SUPPORT_CHAT_ID: env.SUPPORT_CHAT_ID,
    MAX_MESSAGES_PER_MINUTE: String(limit),
  } as unknown as Cloudflare.Env;
}

/** 验证题按钮载荷提取（"v:<n>" → n） */
function optionValues(call: StubbedCall): number[] {
  const markup = (call.body as Record<string, unknown>).reply_markup as {
    inline_keyboard: { callback_data: string }[][];
  };
  return markup.inline_keyboard[0].map((button) => Number(button.callback_data.slice(2)));
}

describe("inbound: 已验证用户全链（置顶 ✅ / 中继 / 账本；阶段 3 回归）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  it("通过验证后的首条消息全链：建档已就绪 + 建 topic + 置顶（恰一条，验证行 ✅）+ 中继 + 账本，顺序 pin→relay", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 100 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 500 } } });

    await seedVerifiedUser({ id: 7101, first_name: "Alice", last_name: "L", username: "alice_hd" });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7101, first_name: "Alice", last_name: "L", username: "alice_hd" }));

    // users 行：昵称缓存 + active + 双时间戳
    const user = await readUser(7101);
    expect(user).toMatchObject({
      first_name: "Alice",
      last_name: "L",
      username: "alice_hd",
      status: "active",
    });
    expect(user!.first_seen_at).not.toBeNull();
    // topics 行：thread 100、title 取 first_name、open、置顶消息已落库
    expect(await readTopic(7101)).toEqual({
      thread_id: 100,
      title: "Alice",
      status: "open",
      closed_at: null,
      pinned_msg_id: 500,
    });
    expect(stub.countOf("createForumTopic")).toBe(1);
    // 已验证存量用户（非 start）无欢迎语：sendMessage 恰 2 次，pin→relay
    expect(stub.countOf("sendMessage")).toBe(2);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatPinnedInfo({
        id: 7101,
        first_name: "Alice",
        last_name: "L",
        username: "alice_hd",
        firstSeenAt: user!.first_seen_at,
        verify: "verified",
      }),
      message_thread_id: 100,
    });
    expect(stub.callsOf("sendMessage")[1].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: "你好",
      message_thread_id: 100,
    });
    // 置顶恰一次：pinChatMessage 带静默标记
    expect(stub.countOf("pinChatMessage")).toBe(1);
    expect(stub.callsOf("pinChatMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_id: 500,
      disable_notification: true,
    });
    expect(stub.countOf("editMessageText")).toBe(0);
    // 账本（T25）：in 行双 ID + content_type 逐项断言；置顶/欢迎不入账本
    const messages = await readMessages(7101);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      direction: "in",
      group_msg_id: 500,
      private_msg_id: 10,
      content_type: "text",
      thread_id: 100,
      user_id: 7101,
    });
  });

  it("第二条文本：不重建 topic、欢迎语不触发；昵称变更 → editMessageText 刷新置顶；first_seen_at 不动", async () => {
    stub.on("createForumTopic", () => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 200 } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 501 } } });

    await seedVerifiedUser({ id: 7102, first_name: "旧名", username: "old" });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7102, first_name: "旧名", username: "old" }, "第一条", 20));
    // 手工倒填 first_seen_at，验证后续 ensureUser 不会覆盖创建侧列
    await env.HODOR_DB.prepare(
      "UPDATE users SET first_seen_at = '2020-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7102)
      .run();

    await handleInbound(env, BOT_ID, privateMessage({ id: 7102, first_name: "新名", username: "new" }, "第二条", 21));

    expect(stub.countOf("createForumTopic")).toBe(1);
    expect(stub.countOf("pinChatMessage")).toBe(1); // 置顶不重复
    // 已验证存量用户（非 start）零欢迎语（阶段 4：欢迎语只属于首联包 / start）
    expect(welcomeCalls(stub, 7102)).toHaveLength(0);
    // 两条中继都落在同一 thread（区分于置顶信息：按 text 过滤）
    expect(relayCalls(stub, "第一条")).toHaveLength(1);
    expect(relayCalls(stub, "第二条")).toHaveLength(1);
    for (const text of ["第一条", "第二条"]) {
      expect(relayCalls(stub, text)[0].body).toMatchObject({
        chat_id: SUPPORT_CHAT_ID,
        message_thread_id: 200,
      });
    }
    // 昵称变更触发 4b：editMessageText 刷新为最新昵称（firstSeenAt 用库内建档时间；验证行 ✅）
    expect(stub.countOf("editMessageText")).toBe(1);
    expect(stub.callsOf("editMessageText")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_id: 501,
      text: formatPinnedInfo({
        id: 7102,
        first_name: "新名",
        username: "new",
        firstSeenAt: "2020-01-01T00:00:00.000Z",
        verify: "verified",
      }),
    });
    // 昵称缓存已刷新；first_seen_at 保持首行值；last_seen_at 晚于 first_seen_at
    const user = await readUser(7102);
    expect(user).toMatchObject({ first_name: "新名", username: "new" });
    expect(user!.first_seen_at).toBe("2020-01-01T00:00:00.000Z");
    expect(user!.last_seen_at > "2020-01-01T00:00:00.000Z").toBe(true);
    // 账本两行 in（文本），双 ID 与原始 message_id 对应
    const messages = await readMessages(7102);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      direction: "in",
      group_msg_id: 501,
      private_msg_id: 20,
      content_type: "text",
    });
    expect(messages[1]).toMatchObject({
      direction: "in",
      group_msg_id: 501,
      private_msg_id: 21,
      content_type: "text",
    });
  });

  it("closed 行：重开（status=open, closed_at=NULL）并复用原 thread，不重建、**不重发置顶**", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 300 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 502 } } });
    stub.always("reopenForumTopic", { status: 200, json: { ok: true, result: true } });

    await seedVerifiedUser({ id: 7103, first_name: "Carol" });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7103, first_name: "Carol" }, "第一条", 30));
    await env.HODOR_DB.prepare(
      "UPDATE topics SET status = 'closed', closed_at = '2025-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7103)
      .run();

    await handleInbound(env, BOT_ID, privateMessage({ id: 7103, first_name: "Carol" }, "又来了", 31));

    expect(await readTopic(7103)).toEqual({
      thread_id: 300,
      title: "Carol",
      status: "open",
      closed_at: null,
      pinned_msg_id: 502, // 重开保留原置顶
    });
    // T38 重开链路：reopenForumTopic 真重开 TG 侧（恰一次，参数指向原 thread）
    expect(stub.countOf("reopenForumTopic")).toBe(1);
    expect(stub.callsOf("reopenForumTopic")[0].body).toMatchObject({ message_thread_id: 300 });
    expect(stub.countOf("createForumTopic")).toBe(1);
    expect(stub.countOf("pinChatMessage")).toBe(1); // 恰一条置顶（不重发）
    expect(relayCalls(stub, "又来了")[0].body).toMatchObject({ message_thread_id: 300 });
    // 欢迎语在已验证存量用户上不触发
    expect(welcomeCalls(stub, 7103)).toHaveLength(0);
  });

  it("title 三级回退：first_name 空白 → @username；两者皆无 → ID_<user_id>", async () => {
    stub.on("createForumTopic", (i) => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 400 + i } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await seedVerifiedUser({ id: 7104, username: "bob_hd" });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7104, username: "bob_hd" }));
    expect((await readTopic(7104))!.title).toBe("@bob_hd");

    await seedVerifiedUser({ id: 7105 });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7105 }));
    expect((await readTopic(7105))!.title).toBe("ID_7105");

    // first_name 全空白同样回退到 @username
    await seedVerifiedUser({ id: 7106, first_name: "   ", username: "ws_user" });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7106, first_name: "   ", username: "ws_user" }));
    expect((await readTopic(7106))!.title).toBe("@ws_user");
  });
});

describe("inbound: 媒体入站（T22）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  it("7 类媒体逐类：对应 sendX 恰一次（thread + file_id + caption，无多余键），已验证用户首条媒体全链生效", async () => {
    // thread 逐次递增：UNIQUE (bot_id, thread_id) 不允许多用户共用同一 thread
    stub.on("createForumTopic", (i) => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 700 + i } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 901 } } });
    const mediaSendMethods = ["sendPhoto", "sendVideo", "sendVoice", "sendAudio", "sendDocument", "sendSticker", "sendAnimation"];
    for (const method of mediaSendMethods) {
      stub.always(method, { status: 200, json: { ok: true, result: { message_id: 902 } } });
    }

    const cases = [
      {
        userId: 7115,
        type: "photo",
        // photo 取最大尺寸 file_id；caption 一并透传
        content: {
          photo: [
            { file_id: "p_small", file_unique_id: "u1", width: 320, height: 240 },
            { file_id: "p_big", file_unique_id: "u2", width: 1280, height: 960 },
          ],
          caption: "配图说明",
        },
        method: "sendPhoto",
        wire: { photo: "p_big", caption: "配图说明" },
      },
      {
        userId: 7116,
        type: "video",
        content: { video: { file_id: "vid_1" }, caption: "视频说明" },
        method: "sendVideo",
        wire: { video: "vid_1", caption: "视频说明" },
      },
      {
        userId: 7117,
        type: "voice",
        content: { voice: { file_id: "vce_1" } },
        method: "sendVoice",
        wire: { voice: "vce_1" },
      },
      {
        userId: 7132,
        type: "audio",
        // 音频（音乐文件，2026-09-30 增补）：file_id + caption 透传，title/performer 忽略
        content: { audio: { file_id: "aud_1", title: "歌名", performer: "歌手" }, caption: "一首歌" },
        method: "sendAudio",
        wire: { audio: "aud_1", caption: "一首歌" },
      },
      {
        userId: 7118,
        type: "document",
        content: { document: { file_id: "doc_1" }, caption: "文件说明" },
        method: "sendDocument",
        wire: { document: "doc_1", caption: "文件说明" },
      },
      {
        userId: 7119,
        type: "sticker",
        // sticker 不可能携带 caption：即便畸形地出现也不透传
        content: { sticker: { file_id: "stk_1" }, caption: "不该出现" },
        method: "sendSticker",
        wire: { sticker: "stk_1" },
      },
      {
        userId: 7120,
        type: "animation",
        content: { animation: { file_id: "gif_1" }, caption: "动图" },
        method: "sendAnimation",
        wire: { animation: "gif_1", caption: "动图" },
      },
    ];

    for (const [index, c] of cases.entries()) {
      const from = { id: c.userId, first_name: `M${c.userId}` };
      await seedVerifiedUser(from);
      const threadId = 700 + index;
      await handleInbound(env, BOT_ID, privateContentMessage(from, c.content, 15));

      // 对应 sendX 恰一次，精确键集：chat + thread + file_id(+caption)
      expect(stub.countOf(c.method), `method ${c.method}`).toBe(1);
      expect(stub.callsOf(c.method)[0].body, `method ${c.method}`).toEqual({
        chat_id: SUPPORT_CHAT_ID,
        message_thread_id: threadId,
        ...c.wire,
      });
      // 已验证用户首条媒体与文本同权：建档 + 建 topic + 置顶 + 账本全链（无欢迎语）
      expect(await readUser(c.userId), `user ${c.userId}`).not.toBeNull();
      const topic = await readTopic(c.userId);
      expect(topic!.thread_id).toBe(threadId);
      expect(topic!.pinned_msg_id).toBe(901);
      expect(welcomeCalls(stub, c.userId), `welcome ${c.userId}`).toHaveLength(0);
      expect(stub.countOf("pinChatMessage"), `pin ${c.userId}`).toBe(index + 1);
      const messages = await readMessages(c.userId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        direction: "in",
        group_msg_id: 902,
        private_msg_id: 15,
        content_type: c.type,
        thread_id: threadId,
        user_id: c.userId,
      });
    }
  });
});

describe("inbound: /start 频控（T23；已验证用户）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  it("60 秒内反复 /start（含 @bot / payload 变体）：欢迎语恰 1 次、topic 恰 1 个；/start 短路——不中继、不写账本，topic 零新增消息", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 710 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await seedVerifiedUser({ id: 7121, first_name: "Start" });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7121, first_name: "Start" }, "/start", 1));
    await handleInbound(env, BOT_ID, privateMessage({ id: 7121, first_name: "Start" }, "/start@hodor_bot", 2));
    await handleInbound(env, BOT_ID, privateMessage({ id: 7121, first_name: "Start" }, "/start payload", 3));

    // 欢迎语恰 1 次（频控窗口内）；topic 恰 1 个（start 不新建）
    expect(welcomeCalls(stub, 7121)).toHaveLength(1);
    expect(stub.countOf("createForumTopic")).toBe(1);
    const topics = await env.HODOR_DB.prepare(
      "SELECT COUNT(*) AS n FROM topics WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7121)
      .first<{ n: number }>();
    expect(topics!.n).toBe(1);
    // /start 是入口命令非对话内容：三条 start 全部不中继（2026-09-30 真机验收修正）
    expect(relayCalls(stub, "/start")).toHaveLength(0);
    expect(relayCalls(stub, "/start@hodor_bot")).toHaveLength(0);
    expect(relayCalls(stub, "/start payload")).toHaveLength(0);
    // 不写账本：topic 零新增消息
    expect(await readMessages(7121)).toHaveLength(0);
    // 群内 sendMessage 恰 1 条 = 置顶信息（首条 /start 建 topic 后 topic 里只有置顶）
    const inTopic = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === SUPPORT_CHAT_ID);
    expect(inTopic).toHaveLength(1);
  });

  it("非 start 文本不触发欢迎；窗口过期（倒填 last_notice_at）后 /start 可再触发", async () => {
    // thread 逐次递增且避开其他用例已占号段（文件内 DB 共享，thread 全局唯一）
    stub.on("createForumTopic", (i) => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 750 + i } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    // 已验证用户：普通文本 / 前缀巧合（/startups）都不触发欢迎
    await seedVerifiedUser({ id: 7122, first_name: "N" });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7122, first_name: "N" }, "普通消息", 5));
    await handleInbound(env, BOT_ID, privateMessage({ id: 7122, first_name: "N" }, "/startups", 6));
    expect(welcomeCalls(stub, 7122)).toHaveLength(0);
    expect(stub.countOf("createForumTopic")).toBe(1);

    // 另一已验证用户 60s 后再 start：slot 重新可赢（窗口过期再触发）
    await seedVerifiedUser({ id: 7123, first_name: "W" });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7123, first_name: "W" }, "普通消息", 7));
    expect(welcomeCalls(stub, 7123)).toHaveLength(0); // 普通文本不触发
    await env.HODOR_DB.prepare(
      "UPDATE users SET last_notice_at = '2020-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7123)
      .run();
    await handleInbound(env, BOT_ID, privateMessage({ id: 7123, first_name: "W" }, "/start", 8));
    expect(welcomeCalls(stub, 7123)).toHaveLength(1); // 窗口过期后再赢
    expect(stub.countOf("createForumTopic")).toBe(2); // 两个用户各一个 topic，无新建
    expect(relayCalls(stub, "/start")).toHaveLength(0); // start 不中继（普通文本照常）
    expect(relayCalls(stub, "普通消息").length).toBeGreaterThanOrEqual(1);
  });
});

describe("inbound: 阶段边界与 TelegramResult 消费", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  it("支持集之外（video_note / 空 text）：先于一切副作用静默完成——不建档、不建 topic、零调用", async () => {
    stub.always("createForumTopic", { status: 200, json: { ok: true, result: { message_thread_id: 1 } } });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("sendAudio", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    // audio 已于 2026-09-30 纳入支持集（上方媒体用例覆盖），此处用 video_note
    const videoNote = privateContentMessage(
      { id: 7107, first_name: "MediaGuy" },
      { video_note: { file_id: "vn1", length: 30, duration: 8 } },
      11,
    );
    await handleInbound(env, BOT_ID, videoNote);
    await handleInbound(env, BOT_ID, privateMessage({ id: 7107, first_name: "MediaGuy" }, "", 12));

    expect(await readUser(7107)).toBeNull();
    expect(await readTopic(7107)).toBeNull();
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect(stub.countOf("sendMessage")).toBe(0);
    expect(stub.countOf("pinChatMessage")).toBe(0);
    expect(await readMessages(7107)).toHaveLength(0);
  });

  it("中继 retryable（HTTP 503）→ 抛出（→ webhook 500 重推）；置顶已完成、账本零行、topic 供重推复用", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 500 } },
    });
    // sendMessage 按调用序：[0] 置顶信息 ok、[1] 中继 503（已验证非 start：无欢迎语）
    stub.on("sendMessage", (i) =>
      i === 0
        ? { status: 200, json: { ok: true, result: { message_id: 1000 + i } } }
        : { status: 503, json: { ok: false, description: "upstream boom" } },
    );

    await seedVerifiedUser({ id: 7108, first_name: "Dan" });
    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7108, first_name: "Dan" })),
    ).rejects.toThrow(/sendMessage/);
    expect(stub.countOf("sendMessage")).toBe(2);
    // 建档与建 topic 已完成：重推时直接复用，不会二次 createForumTopic
    expect((await readTopic(7108))!.thread_id).toBe(500);
    expect((await readTopic(7108))!.pinned_msg_id).toBe(1000);
    // 中继未成功 → 不写账本（T25：只记成功中继）
    expect(await readMessages(7108)).toHaveLength(0);
  });

  it("中继 permanent（HTTP 400 毒丸）→ 静默完成不抛，不写账本", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 501 } },
    });
    stub.on("sendMessage", (i) =>
      i === 0
        ? { status: 200, json: { ok: true, result: { message_id: 1 } } }
        : {
            status: 400,
            json: { ok: false, error_code: 400, description: "Bad Request: message text is empty" },
          },
    );

    await seedVerifiedUser({ id: 7109, first_name: "Eve" });
    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7109, first_name: "Eve" })),
    ).resolves.toBeUndefined();
    expect(stub.countOf("sendMessage")).toBe(2);
    expect(await readMessages(7109)).toHaveLength(0);
  });

  it("createForumTopic permanent（400）→ 静默完成：不落映射行、不欢迎、不中继（消息按已处理丢弃）", async () => {
    stub.always("createForumTopic", {
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request: need administrator rights" },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await seedVerifiedUser({ id: 7111, first_name: "Frank" });
    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7111, first_name: "Frank" })),
    ).resolves.toBeUndefined();
    expect(await readTopic(7111)).toBeNull();
    // 连欢迎语也不发：topic 无法建立即整条丢弃（阶段 2 语义不变）
    expect(stub.countOf("sendMessage")).toBe(0);
  });
});

describe("inbound: 置顶与欢迎语的失败语义（顺序保证：中继不重复）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  it("置顶信息 send retryable → 抛且中继未发生；重推后补置顶 + 中继恰一次（载体用普通文本：/start 已不中继）", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 720 } },
    });
    // 调用序：#1 [0] 置顶信息 503；重推 #2 [1] 置顶信息 / [2] 中继
    stub.on("sendMessage", (i) =>
      i === 0
        ? { status: 503, json: { ok: false, description: "upstream boom" } }
        : { status: 200, json: { ok: true, result: { message_id: 800 } } },
    );

    await seedVerifiedUser({ id: 7124, first_name: "PinRetry" });
    const message = privateMessage({ id: 7124, first_name: "PinRetry" }, "你好", 40);
    await expect(handleInbound(env, BOT_ID, message)).rejects.toThrow(/sendMessage/);
    expect(stub.countOf("sendMessage")).toBe(1); // 只有置顶信息一次（失败）
    expect(relayCalls(stub, "你好")).toHaveLength(0); // 中继未发生
    expect(welcomeCalls(stub, 7124)).toHaveLength(0); // 已验证非 start：无欢迎语
    // topic 已建、pinned_msg_id 未落（重推重走 4a 的判定依据）
    expect((await readTopic(7124))!.pinned_msg_id).toBeNull();
    expect(await readMessages(7124)).toHaveLength(0);

    // 重推：补置顶 → 中继恰一次
    await expect(handleInbound(env, BOT_ID, message)).resolves.toBeUndefined();
    expect(stub.countOf("createForumTopic")).toBe(1); // 不重建 topic
    expect(stub.countOf("sendMessage")).toBe(3); // 置顶信息(失败) + 置顶信息 + 中继
    expect(stub.countOf("pinChatMessage")).toBe(1);
    expect((await readTopic(7124))!.pinned_msg_id).toBe(800);
    expect(welcomeCalls(stub, 7124)).toHaveLength(0);
    expect(relayCalls(stub, "你好")).toHaveLength(1); // 恰一次，无重复
    expect(await readMessages(7124)).toHaveLength(1);
  });

  it("欢迎语 retryable（/start 载体）→ 抛且未中继；重推 slot 已占不补欢迎，/start 短路零中继零账本", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 721 } },
    });
    // 调用序：#1 [0] 置顶信息 ok、[1] 欢迎语 503；重推 #2 无新调用
    stub.on("sendMessage", (i) =>
      i === 1
        ? { status: 503, json: { ok: false, description: "upstream boom" } }
        : { status: 200, json: { ok: true, result: { message_id: 900 } } },
    );

    await seedVerifiedUser({ id: 7125, first_name: "WelcomeRetry" });
    const start = privateMessage({ id: 7125, first_name: "WelcomeRetry" }, "/start", 41);
    await expect(handleInbound(env, BOT_ID, start)).rejects.toThrow(/sendMessage/);
    expect(stub.countOf("sendMessage")).toBe(2); // 置顶信息 + 欢迎语（失败）
    expect(relayCalls(stub, "/start")).toHaveLength(0);
    expect((await readTopic(7125))!.pinned_msg_id).toBe(900); // 置顶已完成

    // 重推：置顶已落（跳过 4a）、slot 已被占（isStart 命中但 claim 输 → 不补
    // 欢迎，已接受的丢失语义：宁可丢失不轰炸）、/start 短路 → 零新调用
    await expect(handleInbound(env, BOT_ID, start)).resolves.toBeUndefined();
    expect(stub.countOf("sendMessage")).toBe(2);
    expect(stub.countOf("pinChatMessage")).toBe(1);
    // 欢迎语只有 #1 失败的那一次尝试（桩按调用记录，不计成败），重推不再补发
    expect(welcomeCalls(stub, 7125)).toHaveLength(1);
    expect(relayCalls(stub, "/start")).toHaveLength(0); // 入口命令不中继
    expect(await readMessages(7125)).toHaveLength(0); // 不写账本
  });

  it("置顶信息 send permanent → warn 跳过（不落 pinned_msg_id），中继照常；下一条消息补置顶", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 722 } },
    });
    // 调用序：#1 [0] 置顶 400、[1] 中继 400（均 permanent 被吞）；#2 [2] 置顶 ok / [3] 中继 ok
    stub.on("sendMessage", (i) =>
      i < 2
        ? { status: 400, json: { ok: false, error_code: 400, description: "Bad Request" } }
        : { status: 200, json: { ok: true, result: { message_id: 950 } } },
    );

    await seedVerifiedUser({ id: 7126, first_name: "PinPerm" });
    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7126, first_name: "PinPerm" }, "第一条", 50)),
    ).resolves.toBeUndefined();
    // 置 permanent 不落 pinned_msg_id（与 pin permanent 的语义区分）
    expect((await readTopic(7126))!.pinned_msg_id).toBeNull();
    expect(stub.countOf("pinChatMessage")).toBe(0);
    expect(await readMessages(7126)).toHaveLength(0); // 中继也 permanent → 无账本

    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7126, first_name: "PinPerm" }, "第二条", 51)),
    ).resolves.toBeUndefined();
    // pinned_msg_id 仍 null → 重走 4a 补置顶
    expect(stub.countOf("pinChatMessage")).toBe(1);
    expect((await readTopic(7126))!.pinned_msg_id).toBe(950);
    expect(welcomeCalls(stub, 7126)).toHaveLength(0); // 已验证非 start：无欢迎语
    const messages = await readMessages(7126);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ direction: "in", group_msg_id: 950, private_msg_id: 51 });
  });

  it("pin permanent（403）→ warn，信息消息已在仍落 pinned_msg_id；流程继续（中继 + 账本）", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 723 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 960 } } });
    stub.always("pinChatMessage", {
      status: 403,
      json: { ok: false, error_code: 403, description: "Forbidden: not enough rights" },
    });

    await seedVerifiedUser({ id: 7127, first_name: "PinFail" });
    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7127, first_name: "PinFail" })),
    ).resolves.toBeUndefined();
    expect((await readTopic(7127))!.pinned_msg_id).toBe(960);
    expect(welcomeCalls(stub, 7127)).toHaveLength(0);
    expect(relayCalls(stub, "你好")).toHaveLength(1);
    expect(await readMessages(7127)).toHaveLength(1);
  });

  it("4b 刷新 permanent（403）→ best-effort warn 跳过，不阻断中继与账本", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 724 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 970 } } });
    stub.always("editMessageText", {
      status: 403,
      json: { ok: false, error_code: 403, description: "Forbidden" },
    });

    await seedVerifiedUser({ id: 7128, first_name: "旧名" });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7128, first_name: "旧名" }, "第一条", 60));
    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7128, first_name: "新名" }, "第二条", 61)),
    ).resolves.toBeUndefined();
    expect(stub.countOf("editMessageText")).toBe(1); // 尝试过刷新
    expect(relayCalls(stub, "第二条")).toHaveLength(1); // 中继照常
    expect(await readMessages(7128)).toHaveLength(2);
  });
});

describe("inbound: 并发首联竞态（败方清理）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  it("createForumTopic 返回前后被并发写入胜方行 → 删自己新建的 thread，改用胜方行中继", async () => {
    // 异步响应器：在本请求「进行中」模拟并发写者抢先落行（thread 555），
    // 然后本方 createForumTopic 才返回新 thread 999 → insertTopic 唯一冲突
    stub.on("createForumTopic", async () => {
      await env.HODOR_DB.prepare(
        "INSERT INTO topics (bot_id, user_id, thread_id, title, created_at) VALUES (?, 7110, 555, '胜方', ?)",
      )
        .bind(BOT_ID, new Date().toISOString())
        .run();
      return { status: 200, json: { ok: true, result: { message_thread_id: 999 } } };
    });
    stub.always("deleteForumTopic", { status: 200, json: { ok: true, result: true } });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await seedVerifiedUser({ id: 7110, first_name: "Grace" });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7110, first_name: "Grace" }, "竞态首联", 40));

    // 败方清理：删的是自己刚建的新 thread 999
    expect(stub.countOf("deleteForumTopic")).toBe(1);
    expect(stub.callsOf("deleteForumTopic")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: 999,
    });
    // 中继改用胜方行 thread 555；映射表只有一行（无双有效绑定、无孤儿映射）
    expect(relayCalls(stub, "竞态首联")[0].body).toMatchObject({ message_thread_id: 555 });
    expect(await readTopic(7110)).toEqual({
      thread_id: 555,
      title: "胜方",
      status: "open",
      closed_at: null,
      pinned_msg_id: 1, // 胜方行 pinned 为空 → 败方补置顶（4a 判定驱动）
    });
    // 账本落在胜方 thread
    expect((await readMessages(7110))[0]).toMatchObject({
      direction: "in",
      thread_id: 555,
      private_msg_id: 40,
    });
  });
});

describe("inbound: 欢迎语文案可配置（WELCOME_TEXT，验收前增量）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  /** handleInbound 实际读取的最小 env（显式构造，避免本地 .dev.vars 泄漏影响） */
  function envWithWelcome(welcomeText: string): Cloudflare.Env {
    return {
      HODOR_DB: env.HODOR_DB,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      SUPPORT_CHAT_ID: env.SUPPORT_CHAT_ID,
      WELCOME_TEXT: welcomeText,
    } as unknown as Cloudflare.Env;
  }

  it("配置 WELCOME_TEXT → 欢迎语用自定义文案（字面 \\n 解释为换行），频控照常", async () => {
    stub.on("createForumTopic", (i) => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 760 + i } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    // /start 载体（已验证用户：欢迎语仅 start 可达）
    await seedVerifiedUser({ id: 7130, first_name: "Custom" });
    await handleInbound(
      envWithWelcome("定制欢迎语第一行\\n定制欢迎语第二行"),
      BOT_ID,
      privateMessage({ id: 7130, first_name: "Custom" }, "/start", 90),
    );

    // 欢迎语正文 = 自定义文案，字面 \n 已解释为真实换行
    const welcome = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 7130);
    expect(welcome).toHaveLength(1);
    expect(welcome[0].body).toEqual({
      chat_id: 7130,
      text: "定制欢迎语第一行\n定制欢迎语第二行",
    });

    // 频控不动：窗口内再 /start 不重发（也无默认文案混入）
    await handleInbound(
      envWithWelcome("定制欢迎语第一行\\n定制欢迎语第二行"),
      BOT_ID,
      privateMessage({ id: 7130, first_name: "Custom" }, "/start", 91),
    );
    expect(
      stub.callsOf("sendMessage").filter((call) => (call.body as Record<string, unknown>).chat_id === 7130),
    ).toHaveLength(1);
  });

  it("未配置（空串）→ 欢迎语兜底内置默认文案", async () => {
    stub.on("createForumTopic", (i) => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 770 + i } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await seedVerifiedUser({ id: 7131, first_name: "Default" });
    await handleInbound(
      envWithWelcome(""),
      BOT_ID,
      privateMessage({ id: 7131, first_name: "Default" }, "/start", 92),
    );

    // 空串 → null → DEFAULT_WELCOME_TEXT（helper 默认比对内置文案）；
    // 再按精确正文过滤恰一次，排除任何非默认文案混入
    expect(welcomeCalls(stub, 7131)).toHaveLength(1);
    expect(
      stub.callsOf("sendMessage").filter((call) => (call.body as Record<string, unknown>).text === DEFAULT_WELCOME_TEXT),
    ).toHaveLength(1);
  });
});

describe("inbound: 新用户首联包与验证门（T27/T28）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  it("新用户首条消息 → 首联包：欢迎语 + 验证题恰各一条（欢迎先发）、题面带 4 按钮；零 topic / 零置顶 / 零中继 / 零账本", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 501 } } });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7140, first_name: "Newbie" }, "你好", 10));

    // 首联包：欢迎语 [0] + 验证题 [1]（成对、各恰一条、欢迎在前）
    const toUser = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 7140);
    expect(toUser).toHaveLength(2);
    expect(toUser[0].body).toEqual({ chat_id: 7140, text: DEFAULT_WELCOME_TEXT });
    const questionBody = toUser[1].body as Record<string, unknown>;
    expect((questionBody.text as string)).toMatch(
      /^为确认你是真人，请回答下面的算术题：\n[1-9] [-+] [1-9] = \?$/,
    );
    expect(optionValues(toUser[1])).toHaveLength(4);
    expect(new Set(optionValues(toUser[1])).size).toBe(4);

    // 验证门拦截 = 零 topic 副作用、零账本
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect(stub.countOf("pinChatMessage")).toBe(0);
    expect(stub.countOf("editMessageText")).toBe(0);
    expect(await readTopic(7140)).toBeNull();
    expect(await readMessages(7140)).toHaveLength(0);
    // DB 流转：is_verified=0 + pending 题落库（answer ∈ 选项，msgId = 题面消息 ID）
    const gov = await readGov(7140);
    expect(gov!.is_verified).toBe(0);
    expect(gov!.verify_msg_id).toBe(501);
    expect(optionValues(toUser[1])).toContain(gov!.verify_answer);
  });

  it("未验证 /start → 同样被验证门丢弃：欢迎语 + 验证题照发，但不建 topic、不中继、不写账本", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 502 } } });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7141, first_name: "StartGate" }, "/start", 11));

    expect(welcomeCalls(stub, 7141)).toHaveLength(1); // isStart 触发欢迎（slot）
    expect(questionCalls(stub, 7141)).toHaveLength(1); // isNew 首联包后半
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect(relayCalls(stub, "/start")).toHaveLength(0);
    expect(await readMessages(7141)).toHaveLength(0);
  });

  it("存量未验证（无 pending 题）→ 新题（slot 赢得才出）；不欢迎、不建 topic", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 503 } } });

    // 阶段 3 遗留用户：建档即未验证、从未出题（verify_msg_id NULL）
    await ensureUser(env.HODOR_DB, BOT_ID, { id: 7142, first_name: "Legacy" });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7142, first_name: "Legacy" }, "在吗", 12));

    expect(welcomeCalls(stub, 7142)).toHaveLength(0); // 非 isNew / 非 start：无欢迎
    expect(questionCalls(stub, 7142)).toHaveLength(1); // slot（NULL）赢 → 新题
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect((await readGov(7142))!.verify_msg_id).toBe(503);
  });

  it("有 pending 题 + slot 被占 → 静默（持续刷消息不产生持续回复）；slot 窗口过期后再发 → 重出**新题**（换题防死锁）", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 504 } } });

    // 预置：未验证 + pending 题 + notice slot 刚被占（60s 内）
    await ensureUser(env.HODOR_DB, BOT_ID, { id: 7143, first_name: "Pending" });
    await env.HODOR_DB.prepare(
      "UPDATE users SET verify_answer = 3, verify_msg_id = 111, last_notice_at = ? WHERE bot_id = ? AND user_id = ?",
    )
      .bind(new Date().toISOString(), BOT_ID, 7143)
      .run();

    await handleInbound(env, BOT_ID, privateMessage({ id: 7143, first_name: "Pending" }, "刷一条", 13));
    expect(questionCalls(stub, 7143)).toHaveLength(0); // slot 输 → 静默
    expect(welcomeCalls(stub, 7143)).toHaveLength(0);
    expect(stub.countOf("createForumTopic")).toBe(0);
    // 治理列不被触碰（静默即零副作用）
    expect(await readGov(7143)).toMatchObject({ is_verified: 0, verify_answer: 3, verify_msg_id: 111 });

    // 窗口过期 → slot 可赢 → 重出新题（verify_msg_id / answer 均换新）
    await env.HODOR_DB.prepare(
      "UPDATE users SET last_notice_at = '2020-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7143)
      .run();
    await handleInbound(env, BOT_ID, privateMessage({ id: 7143, first_name: "Pending" }, "再刷", 14));
    const questions = questionCalls(stub, 7143);
    expect(questions).toHaveLength(1);
    const gov = await readGov(7143);
    expect(gov!.verify_msg_id).toBe(504); // 新题面消息（≠ 111）
    expect(optionValues(questions[0])).toContain(gov!.verify_answer);
  });

  it("门序：验证门先于限频门——未验证消息不进限频计数（rate_* 原样）", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 505 } } });

    // 未验证 + 限频列预置在窗口上限边缘：若误走限频门，rate_count 会变 20
    await ensureUser(env.HODOR_DB, BOT_ID, { id: 7144, first_name: "Order" });
    await env.HODOR_DB.prepare(
      "UPDATE users SET rate_window_start = ?, rate_count = 19 WHERE bot_id = ? AND user_id = ?",
    )
      .bind(new Date().toISOString(), BOT_ID, 7144)
      .run();

    await handleInbound(env, BOT_ID, privateMessage({ id: 7144, first_name: "Order" }, "验证优先", 15));

    expect(questionCalls(stub, 7144)).toHaveLength(1); // 验证门出题
    expect(await readGov(7144)).toMatchObject({ rate_count: 19, rate_window_start: expect.any(String) });
  });
});

describe("inbound: 封禁门（T35）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  it("封禁用户消息 → 拦截 + 禁言提示（slot 赢得恰 1 条）；零验证题、零 topic、零中继、零账本", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 601 } } });

    // 封禁 + 未验证 + pending 题（若门序错误会先出题 / 先计数）
    await ensureUser(env.HODOR_DB, BOT_ID, { id: 7145, first_name: "Banned" });
    await env.HODOR_DB.prepare(
      "UPDATE users SET is_banned = 1, verify_answer = 3, verify_msg_id = 111, rate_window_start = '2020-01-01T00:00:00.000Z', rate_count = 1 WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7145)
      .run();

    await handleInbound(env, BOT_ID, privateMessage({ id: 7145, first_name: "Banned" }, "让我进群", 20));

    // 唯一一条 bot→用户消息 = 禁言提示
    const toUser = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 7145);
    expect(toUser).toHaveLength(1);
    expect(toUser[0].body).toEqual({ chat_id: 7145, text: "你已被禁言，消息无法送达客服。如有疑问请通过其他方式联系。" });
    expect(questionCalls(stub, 7145)).toHaveLength(0); // 封禁门先于验证门：零验证逻辑
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect(await readTopic(7145)).toBeNull();
    expect(await readMessages(7145)).toHaveLength(0);
    // 验证 / 限频列均不被触碰（门序：封禁最先）
    expect(await readGov(7145)).toMatchObject({
      is_banned: 1,
      is_verified: 0,
      verify_answer: 3,
      verify_msg_id: 111,
      rate_count: 1,
    });

    // 60s 内连发：slot 被占 → 完全静默（不轰炸）
    await handleInbound(env, BOT_ID, privateMessage({ id: 7145, first_name: "Banned" }, "再发", 21));
    expect(stub.countOf("sendMessage")).toBe(1);
  });

  it("封禁门先于一切：已验证用户被封禁 → 同样只收禁言提示，不中继、不建 topic", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 602 } } });

    await seedVerifiedUser({ id: 7146, first_name: "BannedV" });
    await env.HODOR_DB.prepare(
      "UPDATE users SET is_banned = 1 WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7146)
      .run();

    await handleInbound(env, BOT_ID, privateMessage({ id: 7146, first_name: "BannedV" }, "我是验证过的", 22));

    expect(stub.countOf("sendMessage")).toBe(1); // 只有禁言提示
    expect(await readTopic(7146)).toBeNull();
    expect(await readMessages(7146)).toHaveLength(0);
  });

  it("禁言提示 retryable → 抛（slot 已耗，宁丢一条）；permanent → warn 吞", async () => {
    stub.always("sendMessage", { status: 503, json: { ok: false, description: "upstream boom" } });

    await seedVerifiedUser({ id: 7147, first_name: "BanRetry" });
    await env.HODOR_DB.prepare("UPDATE users SET is_banned = 1 WHERE bot_id = ? AND user_id = ?")
      .bind(BOT_ID, 7147)
      .run();
    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7147, first_name: "BanRetry" }, "hi", 23)),
    ).rejects.toThrow(/sendMessage/);

    stub.always("sendMessage", {
      status: 403,
      json: { ok: false, error_code: 403, description: "Forbidden: bot was blocked" },
    });
    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7147, first_name: "BanRetry" }, "again", 24)),
    ).resolves.toBeUndefined();
  });
});

describe("inbound: 限频门（T29 固定窗口）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  /** 播种：已验证用户 + 已置顶 topic（限频链路不再依赖建 topic） */
  async function seedVerifiedWithTopic(
    userId: number,
    threadId: number,
    pinnedMsgId: number,
  ): Promise<void> {
    await seedVerifiedUser({ id: userId, first_name: `R${userId}` });
    await env.HODOR_DB.prepare(
      `INSERT INTO topics (bot_id, user_id, thread_id, title, pinned_msg_id) VALUES (?, ?, ?, 'seed', ?)`,
    )
      .bind(BOT_ID, userId, threadId, pinnedMsgId)
      .run();
  }

  it("超限（limit=3）：第 1..3 条中继，第 4 条拦截——撤验证 + 合并消息（含「3」+ 新题按钮）+ 置顶降级 ❌ + 第 4 条无账本行", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 610 } } });
    await seedVerifiedWithTopic(7150, 320, 555);

    const rateEnv = envWithRateLimit(3);
    await handleInbound(rateEnv, BOT_ID, privateMessage({ id: 7150, first_name: "R7150" }, "快1", 30));
    await handleInbound(rateEnv, BOT_ID, privateMessage({ id: 7150, first_name: "R7150" }, "快2", 31));
    await handleInbound(rateEnv, BOT_ID, privateMessage({ id: 7150, first_name: "R7150" }, "快3", 32));
    for (const text of ["快1", "快2", "快3"]) {
      expect(relayCalls(stub, text)).toHaveLength(1);
      expect(relayCalls(stub, text)[0].body).toMatchObject({ message_thread_id: 320 });
    }

    // 第 4 条：拦截 + 撤验证 + 置顶降级 + 合并消息
    await handleInbound(rateEnv, BOT_ID, privateMessage({ id: 7150, first_name: "R7150" }, "快4", 33));
    expect(relayCalls(stub, "快4")).toHaveLength(0); // 本条未中继
    const gov = await readGov(7150);
    expect(gov!.is_verified).toBe(0); // 超限即撤验证（≠ 封禁）
    expect(gov!.verify_msg_id).toBe(610); // 新题已发并落库
    expect(gov!.rate_count).toBe(3); // 计数停在上限
    // 合并消息：单条 push，提示含限频数字 + 题面 + 4 按钮
    const questions = questionCalls(stub, 7150);
    expect(questions).toHaveLength(1);
    const questionText = (questions[0].body as Record<string, unknown>).text as string;
    expect(questionText).toContain("每分钟最多 3 条");
    expect(questionText).toMatch(/[1-9] [-+] [1-9] = \?$/);
    expect(optionValues(questions[0])).toHaveLength(4);
    expect(optionValues(questions[0])).toContain(gov!.verify_answer);
    // 置顶降级 ❌：edit 既有置顶（best-effort 但默认桩成功）
    expect(stub.countOf("editMessageText")).toBe(1);
    expect(stub.callsOf("editMessageText")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_id: 555,
      text: formatPinnedInfo({
        id: 7150,
        first_name: "R7150",
        firstSeenAt: (await readUser(7150))!.first_seen_at,
        verify: "unverified",
      }),
    });
    // 账本只有前 3 条（第 4 条被拦截不写行）
    expect(await readMessages(7150)).toHaveLength(3);

    // 60s 内再发（现为未验证 + slot 被合并消息占）→ 静默
    await handleInbound(rateEnv, BOT_ID, privateMessage({ id: 7150, first_name: "R7150" }, "快5", 34));
    expect(stub.callsOf("sendMessage").length).toBe(3 + 1); // 3 中继 + 1 合并消息，无新增
  });

  it("跨窗口恢复：rate_window_start ≥ 60s 前且计数已满 → 窗口重置第 1 条放行（超限 ≠ 封禁，验证态保留）", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 611 } } });
    await seedVerifiedWithTopic(7151, 321, 556);
    // 上一窗口残留：计数已满但窗口已过期
    await env.HODOR_DB.prepare(
      "UPDATE users SET rate_window_start = ?, rate_count = 3 WHERE bot_id = ? AND user_id = ?",
    )
      .bind(new Date(Date.now() - 61_000).toISOString(), BOT_ID, 7151)
      .run();

    await handleInbound(env, BOT_ID, privateMessage({ id: 7151, first_name: "R7151" }, "新窗口第一条", 35));

    expect(relayCalls(stub, "新窗口第一条")).toHaveLength(1); // 重置放行
    expect(await readMessages(7151)).toHaveLength(1);
    const gov = await readGov(7151);
    expect(gov).toMatchObject({ is_verified: 1, rate_count: 1 }); // 验证态不受窗口影响
  });

  it("超限且无置顶（pinned NULL）→ 置顶降级跳过（零 edit），合并消息照发", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 612 } } });
    await seedVerifiedUser({ id: 7152, first_name: "NoPin" });
    await env.HODOR_DB.prepare(
      "INSERT INTO topics (bot_id, user_id, thread_id, title) VALUES (?, 7152, 322, 'nopin')",
    )
      .bind(BOT_ID)
      .run();
    // 预置窗口内计数已满（第下一条即超限）
    await env.HODOR_DB.prepare(
      "UPDATE users SET rate_window_start = ?, rate_count = 3 WHERE bot_id = ? AND user_id = ?",
    )
      .bind(new Date().toISOString(), BOT_ID, 7152)
      .run();

    await handleInbound(envWithRateLimit(3), BOT_ID, privateMessage({ id: 7152, first_name: "NoPin" }, "超限无置顶", 36));

    expect(stub.countOf("editMessageText")).toBe(0); // 无置顶可降级
    expect(questionCalls(stub, 7152)).toHaveLength(1); // 合并消息照发
    expect(relayCalls(stub, "超限无置顶")).toHaveLength(0);
  });

  it("限频提示 retryable → 抛（slot 已耗）；permanent → warn 吞且不落库题目", async () => {
    // 用户 A（retryable）：撤验证与置顶降级先于合并消息完成，题目不落库
    stub.always("sendMessage", {
      status: 503,
      json: { ok: false, description: "upstream boom" },
    });
    await seedVerifiedWithTopic(7153, 323, 557);
    await env.HODOR_DB.prepare(
      "UPDATE users SET rate_window_start = ?, rate_count = 3 WHERE bot_id = ? AND user_id = ?",
    )
      .bind(new Date().toISOString(), BOT_ID, 7153)
      .run();

    const rateEnv = envWithRateLimit(3);
    await expect(
      handleInbound(rateEnv, BOT_ID, privateMessage({ id: 7153, first_name: "R7153" }, "boom", 37)),
    ).rejects.toThrow(/sendMessage/);
    // 撤验证与置顶降级已完成（先于合并消息）；题目未落库（先送达后落库）
    expect((await readGov(7153))!.is_verified).toBe(0);

    // 用户 B（permanent）：合并消息发送 403 → warn 吞（题不落库），静默完成
    stub.always("sendMessage", {
      status: 403,
      json: { ok: false, error_code: 403, description: "Forbidden: bot was blocked" },
    });
    await seedVerifiedWithTopic(7154, 324, 558);
    await env.HODOR_DB.prepare(
      "UPDATE users SET rate_window_start = ?, rate_count = 3 WHERE bot_id = ? AND user_id = ?",
    )
      .bind(new Date().toISOString(), BOT_ID, 7154)
      .run();
    await expect(
      handleInbound(rateEnv, BOT_ID, privateMessage({ id: 7154, first_name: "R7154" }, "perm", 38)),
    ).resolves.toBeUndefined();
    expect((await readGov(7154))!.verify_msg_id).toBeNull(); // permanent：题不落库
  });
});

describe("inbound: 高危 24h 提醒与置顶治理行（T36/T37，阶段 5 M2）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
  });
  afterEach(() => {
    stub.restore();
  });

  /** topic 内的高危提醒调用（text 精确匹配 formatRiskTopicNotice 产物） */
  function riskNotices(stub: TelegramFetchStub, displayName: string): StubbedCall[] {
    return stub.callsOf("sendMessage").filter(
      (call) => (call.body as Record<string, unknown>).text === formatRiskTopicNotice(displayName),
    );
  }

  /** 置 is_risk=1（高危前提；不预置 risk_notice_at——首条消息天然赢窗口） */
  const markRisk = (userId: number) =>
    env.HODOR_DB.prepare("UPDATE users SET is_risk = 1 WHERE bot_id = ? AND user_id = ?")
      .bind(BOT_ID, userId)
      .run();

  it("高危用户首条消息 → topic 恰一条提醒 + 中继照常 + 账本照常；24h 内第二条零重复提醒", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 800 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await seedVerifiedUser({ id: 7160, first_name: "RiskA" });
    await markRisk(7160);

    await handleInbound(env, BOT_ID, privateMessage({ id: 7160, first_name: "RiskA" }, "高危来信", 44));

    // 中继 / 账本照常（提醒只是附着物，不影响主链）
    expect(relayCalls(stub, "高危来信")).toHaveLength(1);
    expect(await readMessages(7160)).toHaveLength(1);
    // 提醒恰一条：落 topic、text 为 formatRiskTopicNotice（展示名 = first_name）
    expect(riskNotices(stub, "RiskA")).toHaveLength(1);
    expect(riskNotices(stub, "RiskA")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatRiskTopicNotice("RiskA"),
      message_thread_id: 800,
    });
    // 窗口已记录（risk_notice_at 落值）
    const row = await env.HODOR_DB.prepare(
      "SELECT risk_notice_at FROM users WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7160)
      .first<{ risk_notice_at: string | null }>();
    expect(row!.risk_notice_at).not.toBeNull();

    // 24h 窗口内第二条：零重复提醒、中继 / 账本照常
    await handleInbound(env, BOT_ID, privateMessage({ id: 7160, first_name: "RiskA" }, "第二条", 45));
    expect(riskNotices(stub, "RiskA")).toHaveLength(1);
    expect(relayCalls(stub, "第二条")).toHaveLength(1);
    expect(await readMessages(7160)).toHaveLength(2);
  });

  it("非高危用户 → 零提醒（群内只有置顶信息 + 中继），中继 / 账本照常", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 810 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await seedVerifiedUser({ id: 7161, first_name: "Safe" });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7161, first_name: "Safe" }, "正常来信", 46));

    expect(relayCalls(stub, "正常来信")).toHaveLength(1);
    // 群内 sendMessage 恰 2 条 = 置顶信息 + 中继（无任何提醒形态的消息）
    const groupCalls = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === SUPPORT_CHAT_ID);
    expect(groupCalls).toHaveLength(2);
    expect(await readMessages(7161)).toHaveLength(1);
  });

  it("高危用户 /start 短路 → 零提醒（提醒只附着在成功中继 + 账本之后；slot 未消耗——后续来信照常提醒）", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 820 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    await seedVerifiedUser({ id: 7162, first_name: "RiskStart" });
    await markRisk(7162);

    await handleInbound(env, BOT_ID, privateMessage({ id: 7162, first_name: "RiskStart" }, "/start", 47));

    // start 短路：零提醒、零中继、零账本（群内只有置顶信息一条）
    expect(riskNotices(stub, "RiskStart")).toHaveLength(0);
    expect(relayCalls(stub, "/start")).toHaveLength(0);
    expect(await readMessages(7162)).toHaveLength(0);

    // 后续真实来信照常提醒（slot 未被 start 消耗）
    await handleInbound(env, BOT_ID, privateMessage({ id: 7162, first_name: "RiskStart" }, "start 后来信", 48));
    expect(riskNotices(stub, "RiskStart")).toHaveLength(1);
    expect(relayCalls(stub, "start 后来信")).toHaveLength(1);
  });

  it("提醒 sendMessage retryable → warn 吞不抛（完全 best-effort）：主链成功、消息照常中继、账本照常", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 830 } },
    });
    // 调用序：[0] 置顶信息（4a）、[1] 中继、[2] 高危提醒 → 503（不抛）
    stub.on("sendMessage", (i) =>
      i === 2
        ? { status: 503, json: { ok: false, description: "upstream boom" } }
        : { status: 200, json: { ok: true, result: { message_id: 1 } } },
    );

    await seedVerifiedUser({ id: 7163, first_name: "RiskRetry" });
    await markRisk(7163);

    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7163, first_name: "RiskRetry" }, "主链照常", 49)),
    ).resolves.toBeUndefined();

    // 主链三步全部完成：置顶 + 中继 + 账本；提醒尝试过一次（失败被吞）
    expect(relayCalls(stub, "主链照常")).toHaveLength(1);
    expect(await readMessages(7163)).toHaveLength(1);
    expect(stub.countOf("sendMessage")).toBe(3);
    expect((stub.callsOf("sendMessage")[2].body as Record<string, unknown>).text).toBe(
      formatRiskTopicNotice("RiskRetry"),
    );
  });

  it("置顶治理行接库内真值：4b 昵称刷新的 edit 含高危 + 备注行；4a 新置顶同样带出", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 840 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });

    // 4b：已有置顶 + displayChanged → edit 文本 = 库内真值（is_risk + topics.note）
    await seedVerifiedUser({ id: 7164, first_name: "旧名" });
    await env.HODOR_DB.prepare(
      "INSERT INTO topics (bot_id, user_id, thread_id, title, pinned_msg_id, note) VALUES (?, 7164, 840, 'seed', 564, '仅咨询退款')",
    )
      .bind(BOT_ID)
      .run();
    await markRisk(7164);

    await handleInbound(env, BOT_ID, privateMessage({ id: 7164, first_name: "新名" }, "换名来信", 50));

    expect(stub.countOf("editMessageText")).toBe(1);
    const user = await readUser(7164);
    expect(stub.callsOf("editMessageText")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_id: 564,
      text: formatPinnedInfo({
        id: 7164,
        first_name: "新名",
        firstSeenAt: user!.first_seen_at,
        verify: "verified",
        isRisk: true,
        note: "仅咨询退款",
      }),
    });
    expect(relayCalls(stub, "换名来信")).toHaveLength(1);

    // 4a：既有 topic（note 已在）但未置顶 → 新置顶信息同样带高危 / 备注行
    await seedVerifiedUser({ id: 7165, first_name: "NoPin" });
    await env.HODOR_DB.prepare(
      "INSERT INTO topics (bot_id, user_id, thread_id, title, note) VALUES (?, 7165, 841, 'seed', '历史备注')",
    )
      .bind(BOT_ID)
      .run();
    await markRisk(7165);
    // 预占 24h 提醒窗口：隔离「置顶行渲染」断言（提醒行为已由前序用例覆盖，
    // 否则 thread 841 会多出一条提醒消息混入 pinCalls 计数）
    await env.HODOR_DB.prepare(
      "UPDATE users SET risk_notice_at = ? WHERE bot_id = ? AND user_id = ?",
    )
      .bind(new Date().toISOString(), BOT_ID, 7165)
      .run();

    await handleInbound(env, BOT_ID, privateMessage({ id: 7165, first_name: "NoPin" }, "首条来信", 51));

    const pinCalls = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).message_thread_id === 841);
    expect(pinCalls).toHaveLength(2); // 置顶信息 + 中继
    const user7165 = await readUser(7165);
    expect(pinCalls[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatPinnedInfo({
        id: 7165,
        first_name: "NoPin",
        firstSeenAt: user7165!.first_seen_at,
        verify: "verified",
        isRisk: true,
        note: "历史备注",
      }),
      message_thread_id: 841,
    });
    expect(stub.countOf("pinChatMessage")).toBe(1); // 7165 补置顶（7164 已有）
  });
});

describe("inbound: 验证开关 / TTL / 限频独立（T31/T33，阶段 5 M3）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    defaultPinStubs(stub);
    // settings 表文件内共享：每用例前后归位默认（无行 = 开 + math），
    // 供本文件既有「阶段 4 零改动」用例维持缺省前提
    return env.HODOR_DB.prepare("DELETE FROM settings").run();
  });
  afterEach(() => {
    stub.restore();
    return env.HODOR_DB.prepare("DELETE FROM settings").run();
  });

  /** TTL env 覆盖（其余绑定与 vitest.config.ts 注入值一致；钉死 0 的反例） */
  function envWithTtl(ttlHours: number): Cloudflare.Env {
    return {
      HODOR_DB: env.HODOR_DB,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      SUPPORT_CHAT_ID: env.SUPPORT_CHAT_ID,
      VERIFY_TTL_HOURS: String(ttlHours),
    } as unknown as Cloudflare.Env;
  }

  /** 播种已验证用户（verified_at 可倒填；可选既有 topic + 置顶） */
  async function seedVerifiedAt(
    userId: number,
    verifiedAt: string,
    topic?: { threadId: number; pinnedMsgId: number },
  ): Promise<void> {
    await ensureUser(env.HODOR_DB, BOT_ID, { id: userId, first_name: `T${userId}` });
    await env.HODOR_DB.prepare(
      "UPDATE users SET is_verified = 1, verified_at = ? WHERE bot_id = ? AND user_id = ?",
    )
      .bind(verifiedAt, BOT_ID, userId)
      .run();
    if (topic) {
      await env.HODOR_DB.prepare(
        "INSERT INTO topics (bot_id, user_id, thread_id, title, pinned_msg_id) VALUES (?, ?, ?, 'seed', ?)",
      )
        .bind(BOT_ID, userId, topic.threadId, topic.pinnedMsgId)
        .run();
    }
  }

  it("verifyoff 放行：未验证用户消息零出题、零欢迎（首联包随门跳过），直接中继；置顶验证行「未启用」；验证记录保留", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 900 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 620 } } });
    await setVerificationEnabled(env.HODOR_DB, false);

    await handleInbound(env, BOT_ID, privateMessage({ id: 7170, first_name: "Off" }, "关闭期间来信", 60));

    // 整门跳过：无验证题、无欢迎语（首联包属于门内行为）
    expect(questionCalls(stub, 7170)).toHaveLength(0);
    expect(welcomeCalls(stub, 7170)).toHaveLength(0);
    // 正常链路照走：建 topic + 置顶 + 中继 + 账本
    expect(stub.countOf("createForumTopic")).toBe(1);
    expect(relayCalls(stub, "关闭期间来信")).toHaveLength(1);
    expect(await readMessages(7170)).toHaveLength(1);
    // 置顶验证行三态：开关关闭恒「未启用」（覆盖库内真值——is_verified=0）
    const user = await readUser(7170);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatPinnedInfo({
        id: 7170,
        first_name: "Off",
        firstSeenAt: user!.first_seen_at,
        verify: "disabled",
      }),
      message_thread_id: 900,
    });
    // 记录保留：未被清除 / 未被误标（关闭 ≠ 撤验证）
    expect(await readGov(7170)).toMatchObject({ is_verified: 0, verify_answer: null, verify_msg_id: null });
  });

  it("限频语义独立于验证开关：verifyoff 期间超限仍 markUnverified + 置顶降级 ❌（强制覆盖「未启用」）+ 超限重出题，本条丢弃", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 621 } } });
    await setVerificationEnabled(env.HODOR_DB, false);
    await seedVerifiedAt(7171, new Date().toISOString(), { threadId: 901, pinnedMsgId: 591 });

    const rateEnv = envWithRateLimit(3);
    for (let i = 0; i < 3; i++) {
      await handleInbound(rateEnv, BOT_ID, privateMessage({ id: 7171, first_name: "T7171" }, `快${i}`, 61 + i));
    }
    expect(await readMessages(7171)).toHaveLength(3);

    // 第 4 条超限：限频门不因验证开关跳过——撤验证 + 降级 + 重出题 + 丢弃
    await handleInbound(rateEnv, BOT_ID, privateMessage({ id: 7171, first_name: "T7171" }, "快4", 64));
    expect(relayCalls(stub, "快4")).toHaveLength(0);
    const gov = await readGov(7171);
    expect(gov!.is_verified).toBe(0);
    expect(gov!.verify_msg_id).toBe(621); // 新题已发并落库
    const questions = questionCalls(stub, 7171);
    expect(questions).toHaveLength(1);
    expect((questions[0].body as Record<string, unknown>).text as string).toContain("每分钟最多 3 条");
    // 置顶降级强制 ❌：降级时刻的展示是「验证失败」，不是关闭态的「未启用」
    expect(stub.countOf("editMessageText")).toBe(1);
    expect(stub.callsOf("editMessageText")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_id: 591,
      text: formatPinnedInfo({
        id: 7171,
        first_name: "T7171",
        firstSeenAt: (await readUser(7171))!.first_seen_at,
        verify: "unverified",
      }),
    });
    expect(await readMessages(7171)).toHaveLength(3); // 第 4 条不写账本
  });

  it("verifyon 恢复：已验证（未过期）用户不重验直接中继；未验证用户回验证门收题（本条丢弃）", async () => {
    stub.on("createForumTopic", (i) => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 910 + i } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 622 } } });

    const verified = { id: 7172, first_name: "T7172" };
    await seedVerifiedAt(7172, new Date().toISOString());
    // 往返：关 → 开（期间各发一条，验证记录不受开关影响）
    await setVerificationEnabled(env.HODOR_DB, false);
    await handleInbound(env, BOT_ID, privateMessage(verified, "关闭时", 70));
    await setVerificationEnabled(env.HODOR_DB, true);
    await handleInbound(env, BOT_ID, privateMessage(verified, "重开后", 71));

    // 已验证用户：两次都直接中继、零出题、不重验
    expect(relayCalls(stub, "关闭时")).toHaveLength(1);
    expect(relayCalls(stub, "重开后")).toHaveLength(1);
    expect(questionCalls(stub, 7172)).toHaveLength(0);
    expect((await readGov(7172))!.is_verified).toBe(1);

    // 未验证用户（存量、无 pending）：重开后回到验证门收题，消息丢弃
    await ensureUser(env.HODOR_DB, BOT_ID, { id: 7173, first_name: "T7173" });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7173, first_name: "T7173" }, "收题", 72));
    expect(questionCalls(stub, 7173)).toHaveLength(1);
    expect(relayCalls(stub, "收题")).toHaveLength(0);
    expect(await readMessages(7173)).toHaveLength(0);
  });

  it("TTL=0（缺省值）永不重验：verified_at 远古仍直接中继", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 920 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 623 } } });
    await seedVerifiedAt(7174, "2020-01-01T00:00:00.000Z");

    await handleInbound(envWithTtl(0), BOT_ID, privateMessage({ id: 7174, first_name: "T7174" }, "永久有效", 73));

    expect(relayCalls(stub, "永久有效")).toHaveLength(1);
    expect(questionCalls(stub, 7174)).toHaveLength(0);
    expect((await readGov(7174))!.is_verified).toBe(1);
    expect(await readMessages(7174)).toHaveLength(1);
  });

  it("TTL 过期边界：verifiedAt 恰好 = now−ttl → 过期（撤验证 + 出题 + 丢弃）；边界未及（+2s）→ 不过期直接中继", async () => {
    stub.on("createForumTopic", (i) => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 930 + i } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 624 } } });
    const ttlEnv = envWithTtl(1);

    // 恰好等于边界（≤ now−ttl，含相等）：视为过期——重验
    await seedVerifiedAt(7175, new Date(Date.now() - 3600_000).toISOString());
    await handleInbound(ttlEnv, BOT_ID, privateMessage({ id: 7175, first_name: "T7175" }, "边界上", 74));
    expect(questionCalls(stub, 7175)).toHaveLength(1);
    expect(relayCalls(stub, "边界上")).toHaveLength(0);
    expect(await readGov(7175)).toMatchObject({ is_verified: 0, verified_at: null });

    // 边界未及（晚于 now−ttl 2 秒）：不过期——直接中继、验证态保留
    await seedVerifiedAt(7176, new Date(Date.now() - 3600_000 + 2000).toISOString());
    await handleInbound(ttlEnv, BOT_ID, privateMessage({ id: 7176, first_name: "T7176" }, "边界内", 75));
    expect(questionCalls(stub, 7176)).toHaveLength(0);
    expect(relayCalls(stub, "边界内")).toHaveLength(1);
    expect((await readGov(7176))!.is_verified).toBe(1);
  });

  it("TTL 过期触发全链：markUnverified（verified_at / 题目字段清空）+ 置顶降级 ❌ + 出题 + 本条丢弃（零欢迎——非新用户非 start）", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 625 } } });
    await seedVerifiedAt(7177, new Date(Date.now() - 2 * 3600_000).toISOString(), {
      threadId: 940,
      pinnedMsgId: 594,
    });

    await handleInbound(envWithTtl(1), BOT_ID, privateMessage({ id: 7177, first_name: "T7177" }, "过期来信", 76));

    // 撤验证一步到位：is_verified=0、verified_at / 题目旧值清空、新题落库
    const gov = await readGov(7177);
    expect(gov!.is_verified).toBe(0);
    expect(gov!.verified_at).toBeNull();
    expect(gov!.verify_msg_id).toBe(625);
    // 置顶降级 ❌（best-effort，默认桩成功）：edit 既有置顶
    expect(stub.countOf("editMessageText")).toBe(1);
    expect(stub.callsOf("editMessageText")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_id: 594,
      text: formatPinnedInfo({
        id: 7177,
        first_name: "T7177",
        firstSeenAt: (await readUser(7177))!.first_seen_at,
        verify: "unverified",
      }),
    });
    // 出题恰一条、零欢迎（非 isNew / 非 start——欢迎语语义不随 TTL 路径漂移）
    expect(questionCalls(stub, 7177)).toHaveLength(1);
    expect(welcomeCalls(stub, 7177)).toHaveLength(0);
    // 本条丢弃：零中继、零账本、不建 topic
    expect(relayCalls(stub, "过期来信")).toHaveLength(0);
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect(await readMessages(7177)).toHaveLength(0);
  });

  it("关闭期间过期不判定：verifyoff + 过期 verified_at → 直接放行，verified_at 原样保留（关闭不消耗有效期）", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 950 } },
    });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 626 } } });
    await setVerificationEnabled(env.HODOR_DB, false);
    const staleVerifiedAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    await seedVerifiedAt(7178, staleVerifiedAt);

    await handleInbound(envWithTtl(1), BOT_ID, privateMessage({ id: 7178, first_name: "T7178" }, "关闭期间过期", 77));

    expect(relayCalls(stub, "关闭期间过期")).toHaveLength(1);
    expect(questionCalls(stub, 7178)).toHaveLength(0);
    const gov = await readGov(7178);
    expect(gov!.is_verified).toBe(1);
    expect(gov!.verified_at).toBe(staleVerifiedAt); // 逐字保留（不判定、不撤、不清）
  });

  it("往返重开后按 TTL 判定：verifyoff（过期照常放行）→ verifyon → 同一过期记录触发重验", async () => {
    stub.on("createForumTopic", (i) => ({
      status: 200,
      json: { ok: true, result: { message_thread_id: 960 + i } },
    }));
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 627 } } });
    const staleVerifiedAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    await seedVerifiedAt(7179, staleVerifiedAt);
    const ttlEnv = envWithTtl(1);

    await setVerificationEnabled(env.HODOR_DB, false);
    await handleInbound(ttlEnv, BOT_ID, privateMessage({ id: 7179, first_name: "T7179" }, "关闭时放行", 78));
    expect(relayCalls(stub, "关闭时放行")).toHaveLength(1);
    expect(questionCalls(stub, 7179)).toHaveLength(0);

    await setVerificationEnabled(env.HODOR_DB, true);
    await handleInbound(ttlEnv, BOT_ID, privateMessage({ id: 7179, first_name: "T7179" }, "重开判定", 79));
    expect(questionCalls(stub, 7179)).toHaveLength(1);
    expect(relayCalls(stub, "重开判定")).toHaveLength(0);
    expect(await readGov(7179)).toMatchObject({ is_verified: 0, verified_at: null });
  });
});
