/**
 * 阶段 6 集成（T38 /archive + 物理 /deluser + T39 /purgemsg + T40 /wipealldata
 * + 原生 topic close/reopen 状态同步与 topic 删除自愈）：
 *
 * - /archive：关闭 TG topic、清验证并软标记；保留 users/topic/账本/note，
 *   General 收确认；回访重开原 topic 并重新验证；topic-gone 后替代 topic 自愈。
 * - /deluser：初始只发二次确认；管理员确认后调用 deleteForumTopic 并原子清
 *   users/topics/messages；私聊窗口历史不删；非管理员/取消/超时/永久 API 错安全。
 * - /purgemsg：账本 + 置顶驱动逐条删除（三态计数不把未删标为已清空）、
 *   账本行清理、信息卡重发 + 重新置顶；部分失败计数反馈；无绑定 → T26；
 *   deleteMessage retryable → 抛交重推。
 * - /wipealldata：第一步警告 + 60s 时间戳键盘；确认回调再次鉴权（非管理员
 *   toast 拒绝零 DB 写）、超时改写提示、取消、伪造载荷静默、重复确认幂等；
 *   确认先删全部群内话题再清 users/topics/messages/delete_confirmations，
 *   settings / processed_updates / bots 保留；有话题删除失败则不清库。
 * - 原生服务事件 close/reopen 只更新 topics 状态；TOPIC_CLOSED 中继错误会显式
 *   reopen 后重试本条；topic-gone 会回收死绑定、建替代 topic 并重试本条。
 *   closed 行 reopen topic-gone 也立即建新 topic；open 行仅 /start 不探测（无只读 API）。
 *
 * ADMIN_IDS = "111111111,222222222"（vitest.config.ts）；出站经
 * telegramFetchStub 拦截，无真实网络。阶段 6 新增文件。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  formatWipeTopicsFailed,
  ARCHIVE_CLOSE_FAILED_TEXT,
  ARCHIVE_SUCCESS_TEXT,
  DELUSER_TOAST_CANCELLED,
  DELUSER_TOAST_DONE,
  DELUSER_TOAST_EXPIRED,
  DELUSER_TOAST_FAILED,
  DELUSER_TOAST_NOT_ADMIN,
  DELUSER_WARNING_TEXT,
  formatPurgeConfirmed,
  UNBOUND_TOPIC_NOTICE,
  WIPE_DONE_TEXT,
  WIPE_TOAST_CANCELLED,
  WIPE_TOAST_EXPIRED,
  WIPE_TOAST_NOT_ADMIN,
  WIPE_TOAST_RUNNING,
  WIPE_WARNING_TEXT,
} from "../src/copy";
import { handleOutbound } from "../src/pipeline/outbound";
import { handleInbound } from "../src/pipeline/inbound";
import { handleTopicEvent } from "../src/pipeline/topicEvents";
import { handleDeluserCallback } from "../src/pipeline/deluser";
import { handleWipeCallback } from "../src/pipeline/wipe";
import {
  isMessageGoneError,
  isTopicClosedError,
  isTopicGoneError,
  isTopicNotModifiedError,
} from "../src/pipeline/errors";
import type {
  TelegramCallbackQueryRef,
  TelegramMessageRef,
} from "../src/pipeline/classify";
import { upsertBot } from "../src/store/bots";
import { saveDeleteConfirmation } from "../src/store/deleteConfirmations";
import { ensureUser, markVerified } from "../src/store/users";
import { stubTelegramFetch, type TelegramFetchStub, type StubbedCall } from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const SUPPORT_CHAT_ID = -1001234567890;
const ADMIN_ID = 111111111;
/** 非管理员群成员（ADMIN_IDS 之外） */
const MEMBER_ID = 999999999;

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
});

/** 客服群 topic 内的管理员命令 message 构造（fromId 默认管理员） */
function commandMessage(
  text: string,
  threadId: number,
  fromId: number = ADMIN_ID,
  messageId = 70,
): TelegramMessageRef {
  return {
    message_id: messageId,
    from: { id: fromId, first_name: "Admin" },
    chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
    text,
    message_thread_id: threadId,
  };
}

/** 私聊文本 message 构造 */
function privateMessage(
  from: { id: number; first_name?: string },
  text: string,
  messageId = 10,
): TelegramMessageRef {
  return { message_id: messageId, from, chat: { id: from.id, type: "private" }, text };
}

/** 客服群 topic 内的确认按钮回调构造 */
function wipeCallback(
  data: string,
  fromId: number = ADMIN_ID,
  messageId = 500,
): TelegramCallbackQueryRef {
  return {
    id: `cb-${data}:${fromId}:${messageId}`,
    from: { id: fromId, first_name: fromId === ADMIN_ID ? "Admin" : "Member" },
    message: { message_id: messageId, chat: { id: SUPPORT_CHAT_ID, type: "supergroup" } },
    data,
  };
}

let deletePromptSeq = 550;
async function seedDeletePrompt(userId: number, threadId: number, epoch: number, messageId?: number): Promise<number> {
  const resolved = messageId ?? ++deletePromptSeq;
  await saveDeleteConfirmation(env.HODOR_DB, BOT_ID, resolved, userId, threadId, epoch);
  return resolved;
}

function deluserCallback(
  data: string,
  threadId: number | undefined,
  fromId: number = ADMIN_ID,
  messageId = 550,
): TelegramCallbackQueryRef {
  return {
    id: `cb-${data}:${fromId}:${messageId}`,
    from: { id: fromId, first_name: fromId === ADMIN_ID ? "Admin" : "Member" },
    message: {
      message_id: messageId,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
    },
    data,
  };
}

/** 播种已验证用户 + open 绑定（含置顶 / 备注可选） */
async function seedBinding(
  userId: number,
  threadId: number,
  options: { status?: string; pinnedMsgId?: number | null; note?: string | null } = {},
): Promise<void> {
  await ensureUser(env.HODOR_DB, BOT_ID, { id: userId, first_name: `U${userId}` });
  await env.HODOR_DB.prepare(
    "UPDATE users SET is_verified = 1, verified_at = ? WHERE bot_id = ? AND user_id = ?",
  )
    .bind(new Date().toISOString(), BOT_ID, userId)
    .run();
  await env.HODOR_DB.prepare(
    "INSERT INTO topics (bot_id, user_id, thread_id, title, status, pinned_msg_id, note) VALUES (?, ?, ?, 'seed', ?, ?, ?)",
  )
    .bind(BOT_ID, userId, threadId, options.status ?? "open", options.pinnedMsgId ?? null, options.note ?? null)
    .run();
}

/** 播种账本行（双向） */
async function seedLedgerRow(
  userId: number,
  threadId: number,
  direction: "in" | "out",
  groupMsgId: number,
  privateMsgId: number,
): Promise<void> {
  await env.HODOR_DB.prepare(
    `INSERT INTO messages (bot_id, user_id, thread_id, direction, group_msg_id, private_msg_id, content_type)
     VALUES (?, ?, ?, ?, ?, ?, 'text')`,
  )
    .bind(BOT_ID, userId, threadId, direction, groupMsgId, privateMsgId)
    .run();
}

/** 发到客服群 topic 的 sendMessage（命令回复 / 信息卡） */
function topicSends(stub: TelegramFetchStub, threadId: number): StubbedCall[] {
  return stub.callsOf("sendMessage").filter((call) => {
    const body = call.body as Record<string, unknown>;
    return body.chat_id === SUPPORT_CHAT_ID && body.message_thread_id === threadId;
  });
}

/** 发往用户私聊的 sendMessage（archive 归档提示） */
function userDirectCalls(stub: TelegramFetchStub, userId: number): StubbedCall[] {
  return stub.callsOf("sendMessage").filter(
    (call) => (call.body as Record<string, unknown>).chat_id === userId,
  );
}

const readTopicRow = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT thread_id, status, closed_at, pinned_msg_id, note FROM topics WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<{
      thread_id: number;
      status: string;
      closed_at: string | null;
      pinned_msg_id: number | null;
      note: string | null;
    }>();

const readUserRow = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT status, is_verified, verified_at, verify_answer, verify_msg_id FROM users WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<{
      status: string;
      is_verified: number;
      verified_at: string | null;
      verify_answer: number | null;
      verify_msg_id: number | null;
    }>();

const countTable = (table: "users" | "topics" | "messages" | "processed_updates" | "delete_confirmations") =>
  env.HODOR_DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .first<{ n: number }>()
    .then((row) => row!.n);

describe("errors: 错误摘要谓词（阶段 6）", () => {
  it("isTopicGoneError：thread-not-found / TOPIC_ID_INVALID 命中；TOPIC_CLOSED 与其他不命中（宁漏判不误判）", () => {
    expect(isTopicGoneError("sendMessage HTTP 400: Bad Request: message thread not found")).toBe(true);
    expect(isTopicGoneError("reopenForumTopic HTTP 400: Bad Request: TOPIC_ID_INVALID")).toBe(true);
    expect(isTopicGoneError("sendMessage HTTP 400: Bad Request: TOPIC_CLOSED")).toBe(false);
    expect(isTopicGoneError("sendMessage HTTP 403: Forbidden")).toBe(false);
    expect(isTopicGoneError(undefined)).toBe(false);
  });

  it("isTopicNotModifiedError：幂等 close/reopen 的已达目标态命中", () => {
    expect(isTopicNotModifiedError("closeForumTopic HTTP 400: TOPIC_NOT_MODIFIED")).toBe(true);
    expect(isTopicNotModifiedError("reopenForumTopic HTTP 400: TOPIC_NOT_MODIFIED")).toBe(true);
    expect(isTopicNotModifiedError("sendMessage HTTP 400: TOPIC_CLOSED")).toBe(false);
    expect(isTopicNotModifiedError(undefined)).toBe(false);
  });

  it("isTopicClosedError：区分 topic 关闭与删除", () => {
    expect(isTopicClosedError("sendMessage HTTP 400: TOPIC_CLOSED")).toBe(true);
    expect(isTopicClosedError("sendMessage HTTP 400: TOPIC_ID_INVALID")).toBe(false);
    expect(isTopicClosedError(undefined)).toBe(false);
  });

  it("isMessageGoneError：message to delete not found 命中；其他不命中", () => {
    expect(isMessageGoneError("deleteMessage HTTP 400: Bad Request: message to delete not found")).toBe(true);
    expect(isMessageGoneError("deleteMessage HTTP 400: Bad Request: message can't be deleted")).toBe(false);
    expect(isMessageGoneError(undefined)).toBe(false);
  });
});

describe("Telegram 原生 topic 状态与 service update", () => {
  it("原生 close/reopen 只同步 topics 状态，不触碰用户验证、备注或账本", async () => {
    await seedBinding(7201, 201, { pinnedMsgId: 77, note: "保留备注" });
    await seedLedgerRow(7201, 201, "in", 701, 31);
    const closedEvent: TelegramMessageRef = {
      message_id: 801,
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      message_thread_id: 201,
      forum_topic_closed: {},
    };

    await handleTopicEvent(env.HODOR_DB, BOT_ID, closedEvent);
    const closed = await readTopicRow(7201);
    expect(closed).toMatchObject({ status: "closed", note: "保留备注", pinned_msg_id: 77 });
    expect(closed!.closed_at).not.toBeNull();
    expect(await readUserRow(7201)).toMatchObject({ status: "active", is_verified: 1 });
    expect(await countTable("messages")).toBeGreaterThan(0);

    // 重复 close 幂等，不刷新原 closed_at 时间。
    const closedAt = closed!.closed_at;
    await handleTopicEvent(env.HODOR_DB, BOT_ID, closedEvent);
    expect((await readTopicRow(7201))!.closed_at).toBe(closedAt);

    await handleTopicEvent(env.HODOR_DB, BOT_ID, {
      ...closedEvent,
      message_id: 802,
      forum_topic_closed: undefined,
      forum_topic_reopened: {},
    });
    expect(await readTopicRow(7201)).toMatchObject({ status: "open", closed_at: null, note: "保留备注" });
    expect(await readUserRow(7201)).toMatchObject({ status: "active", is_verified: 1 });
  });
});

describe("commands: /archive（软归档）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("closeForumTopic", { status: 200, json: { ok: true, result: true } });
    stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 1 } } });
  });
  afterEach(() => stub.restore());

  it("清验证并软归档；users/topic/账本/note 保留；成功反馈发到 General 而非 closed topic", async () => {
    await seedBinding(7301, 301, { pinnedMsgId: 900, note: "仅咨询退款" });
    await seedLedgerRow(7301, 301, "in", 801, 11);
    await seedLedgerRow(7301, 301, "out", 802, 12);

    await handleOutbound(env, BOT_ID, commandMessage("/archive", 301));

    expect(await readUserRow(7301)).toEqual({
      status: "deleted",
      is_verified: 0,
      verified_at: null,
      verify_answer: null,
      verify_msg_id: null,
    });
    expect(await readTopicRow(7301)).toMatchObject({
      thread_id: 301,
      status: "closed",
      note: "仅咨询退款",
    });
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND user_id = ?")
        .bind(BOT_ID, 7301)
        .first<{ n: number }>(),
    ).toEqual({ n: 2 });
    expect(stub.countOf("closeForumTopic")).toBe(1);
    expect(userDirectCalls(stub, 7301)).toHaveLength(1);
    const general = stub.callsOf("sendMessage").filter((call) => {
      const body = call.body as Record<string, unknown>;
      return body.chat_id === SUPPORT_CHAT_ID && body.message_thread_id === undefined;
    });
    expect(general).toHaveLength(1);
    expect((general[0].body as Record<string, unknown>).text).toContain(ARCHIVE_SUCCESS_TEXT);
    expect(topicSends(stub, 301)).toHaveLength(1); // 唯一 topic 回复在 closeForumTopic 之前发送
    expect((topicSends(stub, 301)[0].body as Record<string, unknown>).text).toContain("正在软归档");
  });

  it("TOPIC_NOT_MODIFIED 表示原生目标态已满足；archive setters 仍完成", async () => {
    await seedBinding(7302, 302);
    stub.always("closeForumTopic", {
      status: 400,
      json: { ok: false, description: "Bad Request: TOPIC_NOT_MODIFIED" },
    });
    await handleOutbound(env, BOT_ID, commandMessage("/archive", 302));
    expect(await readUserRow(7302)).toMatchObject({ status: "deleted", is_verified: 0 });
    expect(await readTopicRow(7302)).toMatchObject({ status: "closed" });
  });

  it("topic-gone 时仍保留用户与历史，回访会走替代 topic 自愈", async () => {
    await seedBinding(7303, 303, { note: "旧话题备注" });
    await seedLedgerRow(7303, 303, "in", 803, 13);
    stub.always("closeForumTopic", {
      status: 400,
      json: { ok: false, description: "Bad Request: TOPIC_ID_INVALID" },
    });
    await handleOutbound(env, BOT_ID, commandMessage("/archive", 303));
    expect(await readUserRow(7303)).toMatchObject({ status: "deleted", is_verified: 0 });
    expect(await readTopicRow(7303)).toMatchObject({ thread_id: 303, status: "closed", note: "旧话题备注" });
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7303)
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
    expect(topicSends(stub, 303)).toHaveLength(1); // 仅发送 close 前归档提示
    expect((topicSends(stub, 303)[0].body as Record<string, unknown>).text).toContain("正在软归档");
  });

  it("其他 permanent close 失败不写 archive 状态，General 报告失败", async () => {
    await seedBinding(7304, 304);
    stub.always("closeForumTopic", { status: 403, json: { ok: false, description: "Forbidden" } });
    await handleOutbound(env, BOT_ID, commandMessage("/archive", 304));
    expect(await readUserRow(7304)).toMatchObject({ status: "active", is_verified: 1 });
    expect(await readTopicRow(7304)).toMatchObject({ status: "open" });
    const general = stub.callsOf("sendMessage").find((call) => {
      const body = call.body as Record<string, unknown>;
      return body.chat_id === SUPPORT_CHAT_ID && body.message_thread_id === undefined;
    });
    expect((general!.body as Record<string, unknown>).text).toBe(ARCHIVE_CLOSE_FAILED_TEXT);
  });
});

describe("commands: /deluser（物理删除）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("deleteForumTopic", { status: 200, json: { ok: true, result: true } });
    stub.always("answerCallbackQuery", { status: 200, json: { ok: true, result: true } });
    stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 550 } } });
  });
  afterEach(() => stub.restore());

  it("命令只显示二次确认并落库 pending；不先删 API 或 DB", async () => {
    await seedBinding(7310, 310);
    await seedLedgerRow(7310, 310, "in", 810, 20);
    await handleOutbound(env, BOT_ID, commandMessage("/deluser", 310));
    const prompt = topicSends(stub, 310)[0].body as Record<string, unknown>;
    expect(prompt.text).toBe(DELUSER_WARNING_TEXT);
    const buttons = (prompt.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
    expect(buttons.map((button) => button.callback_data)).toHaveLength(2);
    const confirmation = await env.HODOR_DB.prepare(
      "SELECT user_id, thread_id, status FROM delete_confirmations WHERE bot_id = ? AND prompt_msg_id = ?",
    ).bind(BOT_ID, 1).first<{ user_id: number; thread_id: number; status: string }>();
    expect(confirmation).toEqual({ user_id: 7310, thread_id: 310, status: "pending" });
    expect(stub.countOf("deleteForumTopic")).toBe(0);
    expect(await readTopicRow(7310)).toMatchObject({ status: "open" });
    expect(await readUserRow(7310)).toMatchObject({ status: "active", is_verified: 1 });
  });

  it("确认后删 TG topic + users/topics/messages 行；不删私聊消息 API", async () => {
    await seedBinding(7311, 311, { note: "物理删除" });
    await seedLedgerRow(7311, 311, "in", 811, 21);
    await seedLedgerRow(7311, 311, "out", 812, 22);
    await seedLedgerRow(7311, 299, "in", 809, 19); // 原生删除自愈留下的旧 thread 历史也属于该用户
    const epoch = Math.floor(Date.now() / 1000);
    const promptId = await seedDeletePrompt(7311, 311, epoch);

    await handleDeluserCallback(env, BOT_ID, deluserCallback(`d:yes:7311:311:${epoch}`, 311, ADMIN_ID, promptId));

    expect(stub.countOf("deleteForumTopic")).toBe(1);
    expect(stub.callsOf("deleteForumTopic")[0].body).toMatchObject({ chat_id: SUPPORT_CHAT_ID, message_thread_id: 311 });
    expect(await readUserRow(7311)).toBeNull();
    expect(await readTopicRow(7311)).toBeNull();
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND user_id = ?")
        .bind(BOT_ID, 7311)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(stub.countOf("deleteMessage")).toBe(0); // 私聊历史在范围外
    expect((stub.callsOf("answerCallbackQuery")[0].body as Record<string, unknown>).text).toBe(DELUSER_TOAST_DONE);
  });

  it("topic 已被原生删除仍清 DB；其他 permanent 保留全部 DB 行", async () => {
    await seedBinding(7312, 312);
    await seedLedgerRow(7312, 312, "in", 813, 23);
    stub.always("deleteForumTopic", {
      status: 400,
      json: { ok: false, description: "Bad Request: TOPIC_ID_INVALID" },
    });
    const epoch = Math.floor(Date.now() / 1000);
    const promptId = await seedDeletePrompt(7312, 312, epoch);
    await handleDeluserCallback(env, BOT_ID, deluserCallback(`d:yes:7312:312:${epoch}`, 312, ADMIN_ID, promptId));
    expect(await readUserRow(7312)).toBeNull();
    expect(await readTopicRow(7312)).toBeNull();

    await seedBinding(7313, 313);
    await seedLedgerRow(7313, 313, "in", 814, 24);
    const promptId313 = await seedDeletePrompt(7313, 313, epoch);
    stub.always("deleteForumTopic", { status: 403, json: { ok: false, description: "Forbidden" } });
    await handleDeluserCallback(env, BOT_ID, deluserCallback(`d:yes:7313:313:${epoch}`, 313, ADMIN_ID, promptId313));
    expect(await readUserRow(7313)).toMatchObject({ status: "active" });
    expect(await readTopicRow(7313)).toMatchObject({ thread_id: 313, status: "open" });
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7313)
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
    expect((stub.callsOf("answerCallbackQuery").at(-1)!.body as Record<string, unknown>).text).toBe(DELUSER_TOAST_FAILED);
  });

  it("非管理员、取消和超时都不删；同一提示取消后有效期内点击确认仍拒绝", async () => {
    await seedBinding(7314, 314);
    const epoch = Math.floor(Date.now() / 1000);
    const promptId = await seedDeletePrompt(7314, 314, epoch);
    const stalePromptId = await seedDeletePrompt(7314, 314, epoch - 120);
    await handleDeluserCallback(env, BOT_ID, deluserCallback(`d:yes:7314:314:${epoch}`, 314, MEMBER_ID, promptId));
    await handleDeluserCallback(env, BOT_ID, deluserCallback(`d:no:7314:314:${epoch}`, 314, ADMIN_ID, promptId));
    await handleDeluserCallback(env, BOT_ID, deluserCallback(`d:yes:7314:314:${epoch}`, 314, ADMIN_ID, promptId));
    await handleDeluserCallback(env, BOT_ID, deluserCallback(`d:no:7314:314:${epoch - 120}`, 314, ADMIN_ID, stalePromptId));
    await handleDeluserCallback(env, BOT_ID, deluserCallback(`d:yes:7314:314:${epoch - 120}`, 314, ADMIN_ID, stalePromptId));
    expect(stub.countOf("deleteForumTopic")).toBe(0);
    // 取消与超时都把各自提示消息改写为终态并移除键盘（不依赖易漏看的 toast）；
    // 同一超时提示的第二次点击重复编辑为同一文案，幂等无害
    expect(stub.countOf("editMessageText")).toBe(3);
    const editTexts = stub.callsOf("editMessageText").map((call) => (call.body as Record<string, unknown>).text);
    expect(editTexts).toEqual([DELUSER_TOAST_CANCELLED, DELUSER_TOAST_EXPIRED, DELUSER_TOAST_EXPIRED]);
    const staleAnswers = stub.callsOf("answerCallbackQuery").slice(-2).map((call) => (call.body as Record<string, unknown>).text);
    expect(staleAnswers).toEqual([DELUSER_TOAST_EXPIRED, DELUSER_TOAST_EXPIRED]);
    expect(await readTopicRow(7314)).toMatchObject({ status: "open" });
  });

  it("Telegram 省略 callback.message_thread_id 时取消能响应，且不删除任何数据", async () => {
    await seedBinding(7316, 316);
    const epoch = Math.floor(Date.now() / 1000);
    const promptId = await seedDeletePrompt(7316, 316, epoch);

    await handleDeluserCallback(env, BOT_ID, deluserCallback(`d:no:7316:316:${epoch}`, undefined, ADMIN_ID, promptId));

    expect((stub.callsOf("answerCallbackQuery")[0].body as Record<string, unknown>).text).toBe(DELUSER_TOAST_CANCELLED);
    expect((stub.callsOf("editMessageText")[0].body as Record<string, unknown>).text).toBe(DELUSER_TOAST_CANCELLED);
    expect(stub.countOf("deleteForumTopic")).toBe(0);
    expect(await readTopicRow(7316)).toMatchObject({ thread_id: 316, status: "open" });
    expect(await readUserRow(7316)).toMatchObject({ status: "active" });
  });

  it("Telegram 省略 callback.message_thread_id 时确认仍需匹配当前双向绑定", async () => {
    await seedBinding(7317, 317);
    const epoch = Math.floor(Date.now() / 1000);
    const promptId = await seedDeletePrompt(7317, 317, epoch);

    await handleDeluserCallback(env, BOT_ID, deluserCallback(`d:yes:7317:317:${epoch}`, undefined, ADMIN_ID, promptId));

    expect(stub.callsOf("deleteForumTopic")[0].body).toMatchObject({ message_thread_id: 317 });
    expect(await readTopicRow(7317)).toBeNull();
    expect(await readUserRow(7317)).toBeNull();
    expect((stub.callsOf("answerCallbackQuery")[0].body as Record<string, unknown>).text).toBe(DELUSER_TOAST_DONE);
  });

  it("回调带有与按钮目标不一致的 thread_id 时仍拒绝删除", async () => {
    await seedBinding(7318, 318);
    const epoch = Math.floor(Date.now() / 1000);
    const promptId = await seedDeletePrompt(7318, 318, epoch);

    await handleDeluserCallback(env, BOT_ID, deluserCallback(`d:yes:7318:318:${epoch}`, 999, ADMIN_ID, promptId));

    expect(stub.countOf("deleteForumTopic")).toBe(0);
    expect(await readTopicRow(7318)).toMatchObject({ thread_id: 318, status: "open" });
  });

  it("重复成功回调在 binding 已清后不重复删除其他话题", async () => {
    await seedBinding(7315, 315);
    const epoch = Math.floor(Date.now() / 1000);
    const promptId = await seedDeletePrompt(7315, 315, epoch);
    await handleDeluserCallback(env, BOT_ID, deluserCallback(`d:yes:7315:315:${epoch}`, 315, ADMIN_ID, promptId));
    await handleDeluserCallback(env, BOT_ID, deluserCallback(`d:yes:7315:315:${epoch}`, 315));
    expect(stub.countOf("deleteForumTopic")).toBe(1);
    expect(await readTopicRow(7315)).toBeNull();
    expect((stub.callsOf("answerCallbackQuery").at(-1)!.body as Record<string, unknown>).text).toBe(DELUSER_TOAST_FAILED);
  });
});

describe("commands: /purgemsg（T39）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("deleteMessage", { status: 200, json: { ok: true, result: true } });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });
  });
  afterEach(() => stub.restore());

  it("全链：账本双向 + 置顶逐条删除 → 账本清理 → 信息卡重发 + 重新置顶；三态计数全删形态", async () => {
    await seedBinding(7401, 401, { pinnedMsgId: 601 });
    await seedLedgerRow(7401, 401, "in", 611, 21);
    await seedLedgerRow(7401, 401, "out", 612, 22);
    await seedLedgerRow(7401, 401, "in", 613, 23);

    await handleOutbound(env, BOT_ID, commandMessage("/purgemsg", 401));

    // 删除列表 = 账本去重 group_msg_id + 置顶（601）= 4 条，逐条调用
    expect(stub.countOf("deleteMessage")).toBe(4);
    const deletedIds = stub.callsOf("deleteMessage").map(
      (call) => (call.body as Record<string, unknown>).message_id,
    );
    expect(deletedIds).toEqual([601, 611, 612, 613]);
    // 账本行清理
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
        .bind(401)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    // 置顶重置：pinned 清空后重发信息卡（新 ID）+ 重新 pin
    expect(await readTopicRow(7401)).toMatchObject({ pinned_msg_id: 1 });
    expect(stub.countOf("pinChatMessage")).toBe(1);
    // 确认三态计数（全删形态 + 信息卡成功重置）
    const reply = topicSends(stub, 401).at(-1)!.body as Record<string, unknown>;
    expect(reply.text).toBe(formatPurgeConfirmed({ deleted: 4, gone: 0, failed: 0, pinnedReset: true }));
  });

  it("部分失败三态：已删 / 已不存在（not found）/ 失败（权限）分别计数，不把未删标为已清空", async () => {
    await seedBinding(7402, 402, { pinnedMsgId: 602 });
    await seedLedgerRow(7402, 402, "in", 621, 31);
    await seedLedgerRow(7402, 402, "out", 622, 32);
    await seedLedgerRow(7402, 402, "in", 623, 33);
    stub.on("deleteMessage", (i) => {
      if (i === 0) return { status: 200, json: { ok: true, result: true } }; // 602 置顶删除成功
      if (i === 1) return { status: 200, json: { ok: true, result: true } }; // 621 删除成功
      if (i === 2) {
        return { status: 400, json: { ok: false, description: "Bad Request: message to delete not found" } };
      }
      return { status: 400, json: { ok: false, description: "Bad Request: message can't be deleted" } };
    });

    await handleOutbound(env, BOT_ID, commandMessage("/purgemsg", 402));

    const reply = topicSends(stub, 402).at(-1)!.body as Record<string, unknown>;
    expect(reply.text).toBe(formatPurgeConfirmed({ deleted: 2, gone: 1, failed: 1, pinnedReset: true }));
    expect(reply.text as string).toContain("未清空");
    // 账本仍清理（失败条目不再追踪）
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
        .bind(402)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("无绑定 → T26 提示，零删除调用", async () => {
    await handleOutbound(env, BOT_ID, commandMessage("/purgemsg", 499));
    const replies = topicSends(stub, 499);
    expect(replies).toHaveLength(1);
    expect((replies[0].body as Record<string, unknown>).text).toBe(UNBOUND_TOPIC_NOTICE);
    expect(stub.countOf("deleteMessage")).toBe(0);
  });

  it("deleteMessage retryable → 抛交重推（已删条目在重跑中收敛为 gone 类）", async () => {
    await seedBinding(7403, 403, { pinnedMsgId: 603 });
    await seedLedgerRow(7403, 403, "in", 631, 41);
    await seedLedgerRow(7403, 403, "in", 632, 42);
    stub.on("deleteMessage", (i) =>
      i === 0
        ? { status: 200, json: { ok: true, result: true } } // 603 删除成功
        : i === 1
          ? { status: 500, json: { ok: false, description: "Internal Server Error" } } // 631 retryable
          : { status: 200, json: { ok: true, result: true } },
    );

    await expect(
      handleOutbound(env, BOT_ID, commandMessage("/purgemsg", 403)),
    ).rejects.toThrow("deleteMessage");
    // 中断即未达收尾：账本保留（重推重跑收敛）
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
        .bind(403)
        .first<{ n: number }>(),
    ).toEqual({ n: 2 });
  });

  it("信息卡重发 permanent → 确认注明「未能重新置顶」，不虚报（pinnedReset=false）", async () => {
    await seedBinding(7405, 405, { pinnedMsgId: 605 });
    await seedLedgerRow(7405, 405, "in", 651, 61);
    // 信息卡 send（正文含「用户 ID」行）permanent 失败；确认回复成功
    stub.on("sendMessage", (i) => {
      const call = stub.callsOf("sendMessage")[i];
      const body = call.body as Record<string, unknown>;
      return typeof body.text === "string" && body.text.includes("用户 ID")
        ? { status: 400, json: { ok: false, description: "Bad Request: message thread not found" } }
        : { status: 200, json: { ok: true, result: { message_id: 1 } } };
    });

    await handleOutbound(env, BOT_ID, commandMessage("/purgemsg", 405));

    const reply = topicSends(stub, 405).at(-1)!.body as Record<string, unknown>;
    expect(reply.text as string).toContain("未能重新置顶");
    expect(reply.text as string).not.toContain("已重新发送并置顶");
    // pinned_msg_id 保持 null——下次消息 4a 自然补
    expect(await readTopicRow(7405)).toMatchObject({ pinned_msg_id: null });
  });

  it("closed 行可操作（治理不依赖 open）", async () => {
    await seedBinding(7404, 404, { status: "closed" });
    await seedLedgerRow(7404, 404, "in", 641, 51);
    await handleOutbound(env, BOT_ID, commandMessage("/purgemsg", 404));
    expect(stub.countOf("deleteMessage")).toBe(1);
  });
});

describe("commands + wipe 回调：/wipealldata 两步确认（T40）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 500 } } });
    stub.always("answerCallbackQuery", { status: 200, json: { ok: true, result: true } });
    stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 500 } } });
    stub.always("deleteForumTopic", { status: 200, json: { ok: true, result: true } });
  });
  afterEach(() => stub.restore());

  it("第一步：警告文案 + 键盘（yes/no 各携带发起时间戳）；零 DB 副作用", async () => {
    const before = await countTable("topics");
    await handleOutbound(env, BOT_ID, commandMessage("/wipealldata", 501));

    const reply = topicSends(stub, 501)[0].body as Record<string, unknown>;
    expect(reply.text).toBe(WIPE_WARNING_TEXT);
    const keyboard = reply.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
    const datas = keyboard.inline_keyboard.flat().map((button) => button.callback_data);
    expect(datas).toHaveLength(2);
    const nowEpoch = Math.floor(Date.now() / 1000);
    for (const data of datas) {
      const match = data.match(/^w:(yes|no):(\d{1,12})$/);
      expect(match).not.toBeNull();
      expect(Number(match![2])).toBeGreaterThanOrEqual(nowEpoch - 5);
      expect(Number(match![2])).toBeLessThanOrEqual(nowEpoch + 5);
    }
    expect(await countTable("topics")).toBe(before); // 第一步零数据变更
  });

  it("确认回调（管理员 + 60s 内）：先删全部群内话题再清库；settings / processed_updates / bots 保留", async () => {
    await seedBinding(7501, 601, { note: "x" });
    await seedBinding(7508, 608, { status: "closed" });
    await seedLedgerRow(7501, 601, "in", 701, 81);
    await env.HODOR_DB.prepare(
      "INSERT INTO processed_updates (bot_id, update_id, status) VALUES (?, ?, 'processed')",
    )
      .bind(BOT_ID, 999001)
      .run();
    const epoch = Math.floor(Date.now() / 1000) - 10; // 60s 窗口内
    const topicsBefore = await countTable("topics");

    await handleWipeCallback(env, BOT_ID, wipeCallback(`w:yes:${epoch}`));

    // 先删话题（含 closed 行与文件内共享 DB 的全部既有行）：清单来自 topics 表
    expect(stub.countOf("deleteForumTopic")).toBe(topicsBefore);
    const deletedThreads = stub
      .callsOf("deleteForumTopic")
      .map((call) => (call.body as Record<string, unknown>).message_thread_id);
    expect(deletedThreads).toContain(601);
    expect(deletedThreads).toContain(608);
    // 全部话题删净后才清库
    expect(await countTable("users")).toBe(0);
    expect(await countTable("topics")).toBe(0);
    expect(await countTable("messages")).toBe(0);
    // settings（验证开关缺省行也在）、幂等台账、bot 身份、确认表全部保留/清理正确
    expect(await countTable("processed_updates")).toBe(1);
    expect(await countTable("delete_confirmations")).toBe(0);
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM bots").first<{ n: number }>(),
    ).toEqual({ n: 1 });
    const answered = stub.callsOf("answerCallbackQuery")[0].body as Record<string, unknown>;
    expect(answered.text).toBe(WIPE_TOAST_RUNNING);
    const edited = stub.callsOf("editMessageText")[0].body as Record<string, unknown>;
    expect(edited.text).toBe(WIPE_DONE_TEXT);
  });

  it("话题删除遇 topic-gone 视为已删；非 gone permanent 失败 → 不清库并报失败数", async () => {
    stub.on("deleteForumTopic", (i) => {
      if (i === 0) return { status: 200, json: { ok: true, result: true } }; // thread 601 删除成功
      if (i === 1) {
        return { status: 400, json: { ok: false, description: "Bad Request: TOPIC_ID_INVALID" } }; // 已删
      }
      return { status: 403, json: { ok: false, description: "Forbidden" } }; // 权限失败
    });
    await seedBinding(7511, 611);
    await seedBinding(7512, 612);
    await seedBinding(7513, 613);
    await seedLedgerRow(7511, 611, "in", 711, 91);
    const epoch = Math.floor(Date.now() / 1000);

    await handleWipeCallback(env, BOT_ID, wipeCallback(`w:yes:${epoch}`));

    // 数据保留（重发起可续删剩余话题）
    expect(await countTable("users")).toBeGreaterThanOrEqual(3);
    expect(await countTable("topics")).toBeGreaterThanOrEqual(3);
    const failedAnswer = stub.callsOf("answerCallbackQuery").at(-1)!.body as Record<string, unknown>;
    expect(failedAnswer.text).toBe(formatWipeTopicsFailed(1));
  });

  it("非管理员点击确认 → toast 拒绝、零 DB 写", async () => {
    await seedBinding(7502, 602);
    const [usersBefore, topicsBefore] = [await countTable("users"), await countTable("topics")];
    const epoch = Math.floor(Date.now() / 1000);

    await handleWipeCallback(env, BOT_ID, wipeCallback(`w:yes:${epoch}`, MEMBER_ID));

    expect(await countTable("users")).toBe(usersBefore);
    expect(await countTable("topics")).toBe(topicsBefore);
    const answered = stub.callsOf("answerCallbackQuery")[0].body as Record<string, unknown>;
    expect(answered.text).toBe(WIPE_TOAST_NOT_ADMIN);
    expect(stub.countOf("editMessageText")).toBe(0);
  });

  it("超 60 秒点击确认 → toast 超时放弃 + 原消息改写移除按钮、数据保留", async () => {
    await seedBinding(7503, 603);
    const topicsBefore = await countTable("topics");
    const expired = Math.floor(Date.now() / 1000) - 120;

    await handleWipeCallback(env, BOT_ID, wipeCallback(`w:yes:${expired}`));

    expect(await countTable("topics")).toBe(topicsBefore);
    const answered = stub.callsOf("answerCallbackQuery")[0].body as Record<string, unknown>;
    expect(answered.text).toBe(WIPE_TOAST_EXPIRED);
    expect(stub.countOf("editMessageText")).toBe(1);
    expect((stub.callsOf("editMessageText")[0].body as Record<string, unknown>).text).toContain(WIPE_TOAST_EXPIRED);
  });

  it("取消 → toast + 原消息编辑回警告文案（键盘移除）、数据保留", async () => {
    await seedBinding(7504, 604);
    const topicsBefore = await countTable("topics");
    const epoch = Math.floor(Date.now() / 1000);

    await handleWipeCallback(env, BOT_ID, wipeCallback(`w:no:${epoch}`));

    expect(await countTable("topics")).toBe(topicsBefore);
    const answered = stub.callsOf("answerCallbackQuery")[0].body as Record<string, unknown>;
    expect(answered.text).toBe(WIPE_TOAST_CANCELLED);
    const edited = stub.callsOf("editMessageText")[0].body as Record<string, unknown>;
    expect(edited.text).toBe(WIPE_WARNING_TEXT);
    expect(edited.reply_markup).toBeUndefined(); // 键盘移除
  });

  it("伪造 / 畸形载荷（w:yes:abc、x:…、超长数字）→ 静默完成，零 API 零 DB", async () => {
    await seedBinding(7505, 605);
    const topicsBefore = await countTable("topics");
    for (const bad of ["w:yes:abc", "x:yes:123", `w:yes:${"1".repeat(13)}`, "w:maybe:123"]) {
      await handleWipeCallback(env, BOT_ID, wipeCallback(bad));
    }
    expect(stub.countOf("answerCallbackQuery")).toBe(0);
    expect(await countTable("topics")).toBe(topicsBefore);
  });

  it("完成文案 edit retryable → 抛交重推（清库已先完成，重推收敛到幂等）", async () => {
    await seedBinding(7507, 607);
    stub.always("editMessageText", {
      status: 500,
      json: { ok: false, description: "Internal Server Error" },
    });
    const epoch = Math.floor(Date.now() / 1000);

    await expect(
      handleWipeCallback(env, BOT_ID, wipeCallback(`w:yes:${epoch}`, ADMIN_ID, 507)),
    ).rejects.toThrow("editMessageText");
    // 三表 DELETE 先于完成文案编辑——数据已清（重推重跑幂等收敛）
    expect(await countTable("topics")).toBe(0);
    expect(await countTable("users")).toBe(0);
  });

  it("重复确认幂等（同载荷二次回调）：表仍空、保留表不误删", async () => {
    await seedBinding(7506, 606);
    const epoch = Math.floor(Date.now() / 1000);
    const processedBefore = await countTable("processed_updates");
    await handleWipeCallback(env, BOT_ID, wipeCallback(`w:yes:${epoch}`, ADMIN_ID, 506));
    await handleWipeCallback(env, BOT_ID, wipeCallback(`w:yes:${epoch}`, ADMIN_ID, 506));

    expect(await countTable("users")).toBe(0);
    // 幂等台账跨重复确认原样保留（含此前用例播种的行）
    expect(await countTable("processed_updates")).toBe(processedBefore);
    expect(stub.countOf("editMessageText")).toBe(2); // 两次编辑均执行（幂等展示面）
  });
});

describe("inbound: 原生删除 topic 自愈（阶段 6 兼容性核心）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("reopenForumTopic", { status: 200, json: { ok: true, result: true } });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });
  });
  afterEach(() => stub.restore());

  it("open 行中继 thread-not-found → 绑定回收、当前消息重发到替代 topic 并记账", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 910 } },
    });
    await seedBinding(7601, 701, { pinnedMsgId: 1 });
    // 第一条：中继进已删除 thread → permanent topic-gone
    stub.on("sendMessage", (i) => {
      const call = stub.callsOf("sendMessage")[i];
      const body = call.body as Record<string, unknown>;
      return body.message_thread_id === 701
        ? { status: 400, json: { ok: false, description: "Bad Request: message thread not found" } }
        : { status: 200, json: { ok: true, result: { message_id: 2 } } };
    });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7601, first_name: "A" }, "第一条", 91));

    // 绑定重建：note 随旧行丢失；当前消息在新 topic（910）成功中继并落账本。
    expect(await readTopicRow(7601)).toMatchObject({ thread_id: 910, status: "open" });
    const firstRelay = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).text === "第一条")
      .at(-1);
    expect(firstRelay!.body).toMatchObject({ message_thread_id: 910 });
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7601)
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });

    // 后续消息复用替代 topic，不会重复创建。
    stub.on("sendMessage", () => ({ status: 200, json: { ok: true, result: { message_id: 3 } } }));
    await handleInbound(env, BOT_ID, privateMessage({ id: 7601, first_name: "A" }, "第二条", 92));

    expect(stub.countOf("createForumTopic")).toBe(1);
    const relay = stub
      .callsOf("sendMessage")
      .find((call) => (call.body as Record<string, unknown>).text === "第二条");
    expect(relay!.body).toMatchObject({ message_thread_id: 910 });
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7601)
        .first<{ n: number }>(),
    ).toEqual({ n: 2 });
  });

  it("native close 导致 TOPIC_CLOSED 时显式重开并重试当前消息，不回收 binding", async () => {
    await seedBinding(7602, 702, { pinnedMsgId: 1 });
    stub.on("sendMessage", (i) =>
      i === 0
        ? { status: 400, json: { ok: false, description: "Bad Request: TOPIC_CLOSED" } }
        : { status: 200, json: { ok: true, result: { message_id: 2 } } },
    );

    await handleInbound(env, BOT_ID, privateMessage({ id: 7602, first_name: "B" }, "m", 93));

    expect(await readTopicRow(7602)).toMatchObject({ thread_id: 702, status: "open" });
    expect(stub.countOf("reopenForumTopic")).toBe(1);
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7602)
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
  });

  it("closed 行重开遇 topic-gone → 删行 + 立即建新 topic，本条不丢；users.status 复位 active", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 920 } },
    });
    await seedBinding(7603, 703, { status: "closed" });
    await env.HODOR_DB.prepare(
      "UPDATE users SET status = 'deleted' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7603)
      .run();
    stub.always("reopenForumTopic", {
      status: 400,
      json: { ok: false, description: "Bad Request: TOPIC_ID_INVALID" },
    });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7603, first_name: "C" }, "回来了", 94));

    // 旧绑定回收 + 新 topic（920）承载本条（中继 + 账本齐全）
    expect(await readTopicRow(7603)).toMatchObject({ thread_id: 920, status: "open" });
    expect(stub.countOf("reopenForumTopic")).toBe(1);
    expect(stub.countOf("createForumTopic")).toBe(1);
    const relay = stub
      .callsOf("sendMessage")
      .find((call) => (call.body as Record<string, unknown>).text === "回来了");
    expect(relay!.body).toMatchObject({ message_thread_id: 920 });
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7603)
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
    expect((await readUserRow(7603))!.status).toBe("active");
  });

  it("closed 行重开：reopenForumTopic ok → 复用原 thread、users.status 复位、置顶不重发", async () => {
    await seedBinding(7604, 704, { status: "closed", pinnedMsgId: 55 });
    await env.HODOR_DB.prepare(
      "UPDATE users SET status = 'deleted' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7604)
      .run();

    await handleInbound(env, BOT_ID, privateMessage({ id: 7604, first_name: "D" }, "again", 95));

    expect(await readTopicRow(7604)).toMatchObject({ thread_id: 704, status: "open", pinned_msg_id: 55 });
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect(stub.countOf("pinChatMessage")).toBe(0); // 置顶保留不重发
    expect((await readUserRow(7604))!.status).toBe("active");
  });

  it("closed 行重开遇其他 permanent → 绑定保留、本条丢弃；retryable → 抛交重推", async () => {
    await seedBinding(7605, 705, { status: "closed" });
    stub.always("reopenForumTopic", {
      status: 403,
      json: { ok: false, description: "Forbidden" },
    });
    await handleInbound(env, BOT_ID, privateMessage({ id: 7605, first_name: "E" }, "m1", 96));
    expect(await readTopicRow(7605)).toMatchObject({ thread_id: 705, status: "closed" }); // 行未删
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7605)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 }); // 本条丢弃

    await seedBinding(7606, 706, { status: "closed" });
    stub.always("reopenForumTopic", {
      status: 500,
      json: { ok: false, description: "Internal Server Error" },
    });
    await expect(
      handleInbound(env, BOT_ID, privateMessage({ id: 7606, first_name: "F" }, "m2", 97)),
    ).rejects.toThrow("reopenForumTopic");
    // DB 未动（closed 保持，重推原样重入重开分支）
    expect(await readTopicRow(7606)).toMatchObject({ thread_id: 706, status: "closed" });
  });

  it("archive 回访先重新验证；通过后重开并复用保留的话题与历史", async () => {
    await seedBinding(7608, 708, { status: "closed", note: "归档保留" });
    await env.HODOR_DB.prepare(
      `UPDATE users SET status = 'deleted', is_verified = 0, verified_at = NULL
       WHERE bot_id = ? AND user_id = ?`,
    ).bind(BOT_ID, 7608).run();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 88 } } });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7608, first_name: "U7608" }, "回访", 99));

    expect(stub.countOf("reopenForumTopic")).toBe(0);
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect((await readUserRow(7608))!.is_verified).toBe(0);
    expect(await readTopicRow(7608)).toMatchObject({ status: "closed", note: "归档保留" });
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7608).first<{ n: number }>(),
    ).toEqual({ n: 0 });

    expect(await markVerified(env.HODOR_DB, BOT_ID, 7608)).toBe(true);
    await handleInbound(env, BOT_ID, privateMessage({ id: 7608, first_name: "U7608" }, "验证后消息", 100));
    expect(stub.countOf("reopenForumTopic")).toBe(1);
    expect(await readTopicRow(7608)).toMatchObject({ thread_id: 708, status: "open", note: "归档保留" });
    expect((await readUserRow(7608))!.status).toBe("active");
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7608).first<{ n: number }>(),
    ).toEqual({ n: 1 });
  });

  it("open 绑定的话题被原生删除后用户只发 /start：不伪装探测、不把 start 中继；下一条普通消息触发自愈", async () => {
    await seedBinding(7607, 707, { pinnedMsgId: 77 });
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 9 } } });

    await handleInbound(env, BOT_ID, privateMessage({ id: 7607, first_name: "U7607" }, "/start", 98));

    // Bot API 没有读取单个 forum topic 状态的只读方法；/start 维持控制消息语义，
    // 不向未知有效性的旧 thread 发探测消息。下一条可中继消息才会按 topic-gone 自愈。
    expect(await readTopicRow(7607)).toMatchObject({ thread_id: 707, status: "open" });
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect(stub.countOf("reopenForumTopic")).toBe(0);
    expect(
      stub.callsOf("sendMessage").every((call) => (call.body as Record<string, unknown>).chat_id === 7607),
    ).toBe(true); // 仅私聊欢迎语，无消息发进群、/start 不入账本
    expect(
      await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
        .bind(7607)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});
