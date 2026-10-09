/**
 * 发布回归套件（T11，阶段 7 M3）——单文件顺序场景的端到端汇总回归面。
 *
 * 定位：发布前的「汇总回归」而非分域深度边界——每步只断言主链路与关键
 * 守卫，verify / inbound / outbound / commands / webhook-route / inbox-claim
 * 等分域用例保持不动。全程 SELF.fetch 走真实路由 + secret 头，出站 Telegram
 * 全部经 telegramFetchStub 拦截（未注册 responder 的方法被调用会抛错，
 * 「零调用」用例直接利用这一点：任何意外处理都会把响应打成 500 露馅）。
 *
 * 场景结构（design.md §4；文件内 it 顺序执行、共享同一份 D1 状态）：
 * ① 鉴权面：webhook 缺头 / 错头 → 401；setwebhook 错密钥 → 401；
 *    未知路径 → 404；POST /health → 404；零 DB 写、零出站。
 * ② 入站链：新用户首条私聊文本 → 首联包双发（默认欢迎语 + 验证题，
 *    verify 门默认开启）；零 topic / 零中继 / 零账本；pending 题落库。
 * ③ 答题通过：callback 正确答案（读库取 verify_answer）→ 验证落库 +
 *    题面改通过提示；下一条消息建 topic + 置顶 + 中继原文 + in 账本行。
 * ④ 出站链：管理员在该 topic 发言 → 私聊 sendMessage + out 账本行；
 *    非管理员普通消息 → 200 零出站。
 * ⑤ 幂等：重推 ② 的同一 update 对象（同 update_id）→ duplicate 200，
 *    零处理（无 responder 桩 + 计数双保险）、账本不变。
 * ⑥ 命令：/help 回复动态帮助清单；/ban → 后续该用户入站被拦（禁言提示）
 *    不中继、不落账本；/unban → 恢复中继。
 * ⑦ 限频：构造 env（MAX_MESSAGES_PER_MINUTE=3，env.test.ts 直调先例）
 *    直调入站管线——前 3 条中继、第 4 条超限触发重验提示（文案含数字 3）
 *    + 撤验证、第 5 条被验证门静默拦截（提示频控 slot 已耗）。
 * ⑧ 防毒丸：中继 sendMessage 持续网络错误（throwError）→ 同一 update_id
 *    过期接管重推 MAX_ATTEMPTS 轮后 markFailed 收敛（失败期间行恒
 *    processing、绝不记 processed）；再推 → duplicate 200 零处理、零账本。
 * ⑨ 版本一致：/health 与 /selfcheck（getWebhookInfo 指向本 worker 的
 *    /webhook）响应 version 相等且 === 构建时注入的 VERSION 模块（T08）。
 *
 * 场景间共享状态（文件级变量，每步注释说明前置）：
 * USER_ID 单用户旅程贯穿 ②–⑧；THREAD_ID 在 ③ 建topic 后记录供 ④⑥ 复用；
 * firstUserUpdate / firstUpdateId 保存 ② 的 update 供 ⑤ 幂等重推；
 * updateSeq 为全文件唯一 update_id 计数器（幂等以 update_id 为键）。
 *
 * vitest.config.ts 钉死：MAX_ATTEMPTS=3、MAX_MESSAGES_PER_MINUTE=20、
 * VERIFY_TTL_HOURS=0（永不重验）、WELCOME_TEXT=""（默认文案兜底）、
 * ADMIN_IDS=111111111,222222222。⑧ 的上限值从 parseMaxAttempts(env)
 * 动态取，与 worker 同源。
 */
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseMaxAttempts } from "../src/env";
import { VERSION } from "../src/generated/version";
import {
  BAN_NOTICE,
  DEFAULT_WELCOME_TEXT,
  formatBanConfirmed,
  formatHelpText,
  formatUnbanConfirmed,
  VERIFY_PASSED_TEXT,
  VERIFY_PASSED_TOAST,
  VERIFY_QUESTION_HEADER,
} from "../src/copy";
import { handleInbound } from "../src/pipeline/inbound";
import type { TelegramMessageRef } from "../src/pipeline/classify";
import { upsertBot } from "../src/store/bots";
import {
  stubTelegramFetch,
  type StubbedCall,
  type TelegramFetchStub,
} from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const WEBHOOK_SECRET = env.TELEGRAM_WEBHOOK_SECRET; // 'test-webhook-secret'
const SUPPORT_CHAT_ID = -1001234567890;
const ADMIN_ID = 111111111;
/** ADMIN_IDS 之外的群成员（④ 非管理员静默面） */
const MEMBER_ID = 999999999;

/** 单用户旅程：② 建档 → ③ 验证 + topic → ④–⑥ 出站与治理 → ⑦ 限频 → ⑧ 毒丸 */
const USER_ID = 8001;

/* ---------------- 场景共享状态（it 顺序执行，D1 文件内共享） ---------------- */
/** ③ 建topic 后记录，④ / ⑥ 出站与命令按 thread 反查复用 */
let THREAD_ID = 0;
/** ② 的首条用户 update（对象原样保留，⑤ 以同一 update_id 重推） */
let firstUserUpdate: Record<string, unknown> | null = null;
let firstUpdateId = 0;
/** 全文件唯一 update_id 计数器（幂等台账以 (bot_id, update_id) 为键） */
let updateSeq = 41000;
const nextUpdateId = () => ++updateSeq;

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
});

/* ---------------- 构造辅助（webhook-route / session-maintenance 同形态） ---------------- */

function postWebhook(body: unknown, secret: string | null = WEBHOOK_SECRET): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  return SELF.fetch("https://example.com/webhook", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 用户私聊文本 update（展示字段恒定，避免 4b 昵称刷新混入计数） */
function privateTextUpdate(
  updateId: number,
  userId: number,
  text: string,
  messageId: number,
): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: userId, first_name: "Reg", username: "reg_hd" },
      chat: { id: userId, type: "private" },
      text,
      date: 1700000000,
    },
  };
}

/** 私聊文本 message（⑦ 直调入站管线用） */
function privateMessageRef(userId: number, text: string, messageId: number): TelegramMessageRef {
  return {
    message_id: messageId,
    from: { id: userId, first_name: "Reg", username: "reg_hd" },
    chat: { id: userId, type: "private" },
    text,
  };
}

/** 客服群 topic 内发言 update（④⑥ 出站 / 命令） */
function supportGroupUpdate(
  updateId: number,
  fromId: number,
  text: string,
  messageId: number,
  threadId: number,
): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: fromId, first_name: fromId === ADMIN_ID ? "Admin" : "Member" },
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      message_thread_id: threadId,
      text,
      date: 1700000000,
    },
  };
}

/** 私聊题面按钮回调 update（data 形如 "v:5"；id 形如 cb-<updateId>） */
function callbackUpdate(
  updateId: number,
  userId: number,
  msgId: number,
  data: string,
): Record<string, unknown> {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: userId, first_name: "Reg" },
      message: { message_id: msgId, chat: { id: userId, type: "private" } },
      data,
    },
  };
}

/* ---------------- DB 读取 / 时间窗辅助 ---------------- */

const readProcessed = (updateId: number) =>
  env.HODOR_DB.prepare(
    "SELECT status, attempts FROM processed_updates WHERE bot_id = ? AND update_id = ?",
  )
    .bind(BOT_ID, updateId)
    .first<{ status: string; attempts: number }>();

const readUserGov = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT is_banned, is_verified, verify_answer, verify_msg_id FROM users WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<{
      is_banned: number;
      is_verified: number;
      verify_answer: number | null;
      verify_msg_id: number | null;
    }>();

const countUserLedger = (userId: number) =>
  env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND user_id = ?")
    .bind(BOT_ID, userId)
    .first<{ n: number }>()
    .then((row) => row!.n);

/** 倒填提示频控 slot（模拟上一条提示已过 60s 窗口：⑥ 禁言提示 / ⑦ 超限提示的前置） */
const backdateNoticeSlot = (userId: number) =>
  env.HODOR_DB.prepare("UPDATE users SET last_notice_at = ? WHERE bot_id = ? AND user_id = ?")
    .bind(new Date(Date.now() - 61_000).toISOString(), BOT_ID, userId)
    .run();

/** 倒填认领时间（模拟 60s 过期接管窗口流逝，⑧ 的重推节奏） */
const backdateClaim = (updateId: number) =>
  env.HODOR_DB.prepare(
    "UPDATE processed_updates SET created_at = ? WHERE bot_id = ? AND update_id = ?",
  )
    .bind(new Date(Date.now() - 61_000).toISOString(), BOT_ID, updateId)
    .run();

/** 发到客服群 topic 的 sendMessage（置顶信息卡 / 中继 / 命令回复） */
function topicSends(stub: TelegramFetchStub, threadId: number): StubbedCall[] {
  return stub.callsOf("sendMessage").filter((call) => {
    const body = call.body as Record<string, unknown>;
    return body.chat_id === SUPPORT_CHAT_ID && body.message_thread_id === threadId;
  });
}

/** 发往用户私聊的 sendMessage（提示 / 出站中继） */
function userDirectCalls(stub: TelegramFetchStub, userId: number): StubbedCall[] {
  return stub.callsOf("sendMessage").filter(
    (call) => (call.body as Record<string, unknown>).chat_id === userId,
  );
}

describe("发布回归（T11）：真实部署链路顺序场景", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("① 鉴权面：webhook 缺头/错头 401、setwebhook 错密钥 401、未知路径 404、POST /health 404，零 DB 写零出站", async () => {
    // 不注册任何 responder：任何意外出站调用都会让桩抛错（响应非 401/404），
    // 与行数快照 / 计数断言共同固化「鉴权面前零副作用」
    const counts = async () => {
      const q = async (sql: string) =>
        (await env.HODOR_DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
      return {
        users: await q("SELECT COUNT(*) AS n FROM users"),
        topics: await q("SELECT COUNT(*) AS n FROM topics"),
        processed: await q("SELECT COUNT(*) AS n FROM processed_updates"),
      };
    };
    const before = await counts();

    const missing = await postWebhook(privateTextUpdate(nextUpdateId(), USER_ID, "无头消息", 8001), null);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });

    const wrong = await postWebhook(
      privateTextUpdate(nextUpdateId(), USER_ID, "错头消息", 8002),
      "wrong-secret",
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "unauthorized" });

    const badAdmin = await SELF.fetch("https://example.com/setwebhook/wrong-admin-secret");
    expect(badAdmin.status).toBe(401);
    expect(await badAdmin.json()).toEqual({ error: "无效的管理密钥" });

    const unknown = await SELF.fetch("https://example.com/no-such-path");
    expect(unknown.status).toBe(404);

    // 方法不符：/health 仅接受 GET，其余自然落极薄路由的 404 兜底
    const postHealth = await SELF.fetch("https://example.com/health", { method: "POST" });
    expect(postHealth.status).toBe(404);

    expect(await counts()).toEqual(before);
    expect(stub.countOf("sendMessage")).toBe(0);
  });

  it("② 入站链：新用户首条私聊消息 → 首联包双发（默认欢迎语 + 4 按钮验证题），零 topic / 零中继 / 零账本", async () => {
    // 只注册 sendMessage：createForumTopic / pinChatMessage 不注册——被调用
    // 即抛错 → 500，「未建 topic」由本用例的 200 直接固化
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 6600 } } });

    firstUpdateId = nextUpdateId();
    firstUserUpdate = privateTextUpdate(firstUpdateId, USER_ID, "你们好，我需要帮助", 8101);
    const res = await postWebhook(firstUserUpdate);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(await readProcessed(firstUpdateId)).toEqual({ status: "processed", attempts: 0 });

    // 建档：未验证 + pending 题已落库（答案与题面消息 ID 供 ③ 答题使用）
    const user = await readUserGov(USER_ID);
    expect(user).toMatchObject({ is_verified: 0 });
    expect(user!.verify_answer).not.toBeNull();
    expect(user!.verify_msg_id).toBe(6600);

    // 首联包：默认欢迎语（WELCOME_TEXT 钉死为空 → 兜底文案，无键盘）+
    // 验证题（4 选项按钮）各恰一条，全部发用户私聊
    const toUser = userDirectCalls(stub, USER_ID);
    expect(toUser).toHaveLength(2);
    expect((toUser[0].body as Record<string, unknown>).text).toBe(DEFAULT_WELCOME_TEXT);
    expect((toUser[0].body as Record<string, unknown>).reply_markup).toBeUndefined();
    const question = toUser[1].body as Record<string, unknown>;
    expect(question.text as string).toContain(VERIFY_QUESTION_HEADER);
    expect(
      (question.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard[0],
    ).toHaveLength(4);

    // 零中继（没有任何发往客服群的消息）、零 topic 行、零账本
    expect(
      stub.callsOf("sendMessage").every((call) => {
        return (call.body as Record<string, unknown>).chat_id === USER_ID;
      }),
    ).toBe(true);
    const topics = await env.HODOR_DB.prepare(
      "SELECT COUNT(*) AS n FROM topics WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, USER_ID)
      .first<{ n: number }>();
    expect(topics!.n).toBe(0);
    expect(await countUserLedger(USER_ID)).toBe(0);
  });

  it("③ 答题通过：callback 正确答案 → 验证落库 + 题面改通过提示；下一条消息建 topic + 置顶 + 中继原文 + in 账本", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 6500 } } });
    stub.always("answerCallbackQuery", { status: 200, json: { ok: true, result: true } });
    stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 6600 } } });
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 700 } },
    });
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });

    // 前置：② 留下的 pending 题——正确答案读库（按钮载荷里没有任何
    // 「哪个是对的」信息），题面消息 ID 即 verify_msg_id
    const pending = await readUserGov(USER_ID);
    const callbackId = nextUpdateId();
    const answered = await postWebhook(
      callbackUpdate(callbackId, USER_ID, pending!.verify_msg_id!, `v:${pending!.verify_answer}`),
    );
    expect(answered.status).toBe(200);
    expect(await readProcessed(callbackId)).toEqual({ status: "processed", attempts: 0 });
    expect(stub.callsOf("answerCallbackQuery")[0].body).toEqual({
      callback_query_id: `cb-${callbackId}`,
      text: VERIFY_PASSED_TOAST,
    });
    expect(stub.callsOf("editMessageText")[0].body).toMatchObject({
      chat_id: USER_ID,
      message_id: 6600,
      text: VERIFY_PASSED_TEXT,
    });
    expect(await readUserGov(USER_ID)).toMatchObject({
      is_verified: 1,
      verify_answer: null,
      verify_msg_id: null,
    });
    // 验证回调本身不建 topic（被 ② 拦截的消息不回溯补中继）
    expect(stub.countOf("createForumTopic")).toBe(0);

    // 通过后的第一条消息（② 的消息不回溯，本条是新中继）：建 topic + 置顶 + 中继 + 账本
    const relayText = "答题后的第一条消息";
    const afterVerifyId = nextUpdateId();
    const relayed = await postWebhook(privateTextUpdate(afterVerifyId, USER_ID, relayText, 8102));
    expect(relayed.status).toBe(200);
    expect(await readProcessed(afterVerifyId)).toEqual({ status: "processed", attempts: 0 });
    expect(stub.countOf("createForumTopic")).toBe(1);
    expect(stub.countOf("pinChatMessage")).toBe(1);
    const relay = topicSends(stub, 700).find(
      (call) => (call.body as Record<string, unknown>).text === relayText,
    );
    expect(relay).toBeDefined();
    expect(relay!.body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: relayText,
      message_thread_id: 700,
    });
    // 账本 in 行（group 侧 = 中继结果消息 ID，私聊侧 = 用户原消息 ID）
    const ledger = await env.HODOR_DB.prepare(
      "SELECT direction, thread_id, group_msg_id, private_msg_id, content_type FROM messages WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, USER_ID)
      .first<{
        direction: string;
        thread_id: number;
        group_msg_id: number;
        private_msg_id: number;
        content_type: string;
      }>();
    expect(ledger).toEqual({
      direction: "in",
      thread_id: 700,
      group_msg_id: 6500,
      private_msg_id: 8102,
      content_type: "text",
    });

    // 供 ④⑥ 复用：本场景建立的 topic
    THREAD_ID = 700;
  });

  it("④ 出站链：管理员 topic 发言 → 私聊送达 + out 账本行；非管理员普通消息 → 200 零出站", async () => {
    // 前置：③ 已建立 THREAD_ID 绑定与置顶（本用例零置顶副作用，只注册中继）
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 6500 } } });

    const adminText = "客服已收到，稍后处理";
    const adminUpdateId = nextUpdateId();
    const adminRes = await postWebhook(
      supportGroupUpdate(adminUpdateId, ADMIN_ID, adminText, 8201, THREAD_ID),
    );
    expect(adminRes.status).toBe(200);
    expect(await readProcessed(adminUpdateId)).toEqual({ status: "processed", attempts: 0 });

    // 私聊送达：不带 thread、精确键集
    const relay = userDirectCalls(stub, USER_ID).find(
      (call) => (call.body as Record<string, unknown>).text === adminText,
    );
    expect(relay).toBeDefined();
    expect(relay!.body).toEqual({ chat_id: USER_ID, text: adminText });
    // out 账本行：group 侧 = 管理员原消息 ID，私聊侧 = 中继结果消息 ID
    const outRow = await env.HODOR_DB.prepare(
      "SELECT direction, thread_id, group_msg_id, private_msg_id, content_type FROM messages WHERE bot_id = ? AND user_id = ? AND direction = 'out'",
    )
      .bind(BOT_ID, USER_ID)
      .first<{
        direction: string;
        thread_id: number;
        group_msg_id: number;
        private_msg_id: number;
        content_type: string;
      }>();
    expect(outRow).toEqual({
      direction: "out",
      thread_id: THREAD_ID,
      group_msg_id: 8201,
      private_msg_id: 6500,
      content_type: "text",
    });

    // 非管理员（999999999）普通文本：静默完成，零出站、零账本
    const sendsBefore = stub.countOf("sendMessage");
    const ledgerBefore = await countUserLedger(USER_ID);
    const memberRes = await postWebhook(
      supportGroupUpdate(nextUpdateId(), MEMBER_ID, "群里闲聊一句", 8202, THREAD_ID),
    );
    expect(memberRes.status).toBe(200);
    expect(stub.countOf("sendMessage")).toBe(sendsBefore);
    expect(await countUserLedger(USER_ID)).toBe(ledgerBefore);
  });

  it("⑤ 幂等：重推 ② 的同一 update（同 update_id 同对象）→ duplicate 200，零处理、账本与台账不变", async () => {
    // 不注册任何 responder：duplicate 在认领层即短路，任何进入管线的处理
    // 都会让桩抛错 → 500 露馅（「零处理」的强断言）
    const ledgerBefore = await countUserLedger(USER_ID);
    const res = await postWebhook(firstUserUpdate);
    expect(res.status).toBe(200);
    expect(stub.countOf("sendMessage")).toBe(0);
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect(stub.countOf("pinChatMessage")).toBe(0);
    expect(await countUserLedger(USER_ID)).toBe(ledgerBefore);
    // 台账仍停在 ② 成功后的终态（不重认领、attempts 不变）
    expect(await readProcessed(firstUpdateId)).toEqual({ status: "processed", attempts: 0 });
  });

  it("⑥ 命令：/help 回复动态帮助清单；/ban 拦截入站（禁言提示、零中继零账本）；/unban 恢复中继", async () => {
    // 前置：③ 的 THREAD_ID 绑定 + 用户已验证；命令回复 / 中继 / 禁言提示都是 sendMessage
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 6500 } } });

    // /help：帮助清单接 settings 真值（本文件未写 settings → 默认开 + math）
    const helpUpdateId = nextUpdateId();
    const help = await postWebhook(supportGroupUpdate(helpUpdateId, ADMIN_ID, "/help", 8301, THREAD_ID));
    expect(help.status).toBe(200);
    expect(await readProcessed(helpUpdateId)).toEqual({ status: "processed", attempts: 0 });
    expect(topicSends(stub, THREAD_ID)).toHaveLength(1);
    expect((topicSends(stub, THREAD_ID)[0].body as Record<string, unknown>).text).toBe(
      formatHelpText({ verifyEnabled: true, verifyMode: "math" }),
    );

    // /ban：确认回复 + users.is_banned=1（DB 真值先行）
    const banUpdateId = nextUpdateId();
    const ban = await postWebhook(supportGroupUpdate(banUpdateId, ADMIN_ID, "/ban", 8302, THREAD_ID));
    expect(ban.status).toBe(200);
    expect((topicSends(stub, THREAD_ID)[1].body as Record<string, unknown>).text).toBe(
      formatBanConfirmed(USER_ID),
    );
    expect((await readUserGov(USER_ID))!.is_banned).toBe(1);

    // 被禁言用户入站：拦截 + 禁言提示（提示走 60s 频控 slot——倒填模拟
    // ② 的欢迎语提示已过窗口），零中继、零账本
    await backdateNoticeSlot(USER_ID);
    const topicSendsBefore = topicSends(stub, THREAD_ID).length;
    const ledgerBefore = await countUserLedger(USER_ID);
    const bannedId = nextUpdateId();
    const banned = await postWebhook(privateTextUpdate(bannedId, USER_ID, "被禁言后的消息", 8303));
    expect(banned.status).toBe(200);
    expect(await readProcessed(bannedId)).toEqual({ status: "processed", attempts: 0 });
    const banNotices = userDirectCalls(stub, USER_ID);
    expect(banNotices).toHaveLength(1);
    expect((banNotices[0].body as Record<string, unknown>).text).toBe(BAN_NOTICE);
    expect(topicSends(stub, THREAD_ID).length).toBe(topicSendsBefore);
    expect(await countUserLedger(USER_ID)).toBe(ledgerBefore);

    // /unban：确认回复 + is_banned=0
    const unbanId = nextUpdateId();
    const unban = await postWebhook(supportGroupUpdate(unbanId, ADMIN_ID, "/unban", 8304, THREAD_ID));
    expect(unban.status).toBe(200);
    expect((topicSends(stub, THREAD_ID)[2].body as Record<string, unknown>).text).toBe(
      formatUnbanConfirmed(USER_ID),
    );
    expect((await readUserGov(USER_ID))!.is_banned).toBe(0);

    // 解禁后恢复中继：topic 复用（不重建）、账本 +1
    const afterText = "解禁后的消息";
    const afterId = nextUpdateId();
    const after = await postWebhook(privateTextUpdate(afterId, USER_ID, afterText, 8305));
    expect(after.status).toBe(200);
    const resumed = topicSends(stub, THREAD_ID).find(
      (call) => (call.body as Record<string, unknown>).text === afterText,
    );
    expect(resumed).toBeDefined();
    expect(stub.countOf("createForumTopic")).toBe(0);
    expect(await countUserLedger(USER_ID)).toBe(ledgerBefore + 1);
  });

  it("⑦ 限频：构造 env（MAX_MESSAGES_PER_MINUTE=3）直调入站管线——超限重验提示含数字 + 后续被验证门拦截", async () => {
    // 前置：⑥ 结束时用户已验证、topic 与置顶俱在；editMessageText 供超限
    // 置顶降级（best-effort）使用
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 6500 } } });
    stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 6500 } } });

    // env.test.ts 先例：构造 env 对象覆盖变量（SELF.fetch 的绑定固定不可改，
    // 直调管线保持场景连续性）；限频上限缩到 3 避免按钉死值 20 连发
    const limitedEnv = {
      HODOR_DB: env.HODOR_DB,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      ADMIN_SECRET: env.ADMIN_SECRET,
      SUPPORT_CHAT_ID: "-1001234567890",
      ADMIN_IDS: "111111111,222222222",
      MAX_ATTEMPTS: "3",
      MAX_MESSAGES_PER_MINUTE: "3",
      VERIFY_TTL_HOURS: "0",
      WELCOME_TEXT: "",
    } as unknown as Cloudflare.Env;

    // 重开限频窗口（⑥ 的中继已计数）+ 放开提示频控（⑥ 的禁言提示刚占用 slot）
    await env.HODOR_DB.prepare(
      "UPDATE users SET rate_window_start = NULL, rate_count = 0, last_notice_at = ? WHERE bot_id = ? AND user_id = ?",
    )
      .bind(new Date(Date.now() - 61_000).toISOString(), BOT_ID, USER_ID)
      .run();

    // 1..3 条：正常中继（置顶已在，恰每条一次 sendMessage 落 topic）
    for (let i = 1; i <= 3; i++) {
      await handleInbound(limitedEnv, BOT_ID, privateMessageRef(USER_ID, `限频第 ${i} 条`, 8500 + i));
    }
    const relayTexts = topicSends(stub, THREAD_ID).map(
      (call) => (call.body as Record<string, unknown>).text,
    );
    expect(relayTexts).toEqual(["限频第 1 条", "限频第 2 条", "限频第 3 条"]);
    const ledgerAtLimit = await countUserLedger(USER_ID);

    // 第 4 条：超限 → 撤验证 + 合并重验提示（含 limit 数字），本条不中继不记账
    await handleInbound(limitedEnv, BOT_ID, privateMessageRef(USER_ID, "限频第 4 条", 8504));
    expect((await readUserGov(USER_ID))!.is_verified).toBe(0);
    const overflowNotice = userDirectCalls(stub, USER_ID);
    expect(overflowNotice).toHaveLength(1);
    expect((overflowNotice[0].body as Record<string, unknown>).text as string).toContain(
      "每分钟最多 3 条",
    );
    expect(
      topicSends(stub, THREAD_ID).some(
        (call) => (call.body as Record<string, unknown>).text === "限频第 4 条",
      ),
    ).toBe(false);
    expect(await countUserLedger(USER_ID)).toBe(ledgerAtLimit);

    // 第 5 条：未验证落验证门，提示频控 slot 已被超限消息占用 → 静默丢弃
    const sendsBefore = stub.countOf("sendMessage");
    await handleInbound(limitedEnv, BOT_ID, privateMessageRef(USER_ID, "限频第 5 条", 8505));
    expect(stub.countOf("sendMessage")).toBe(sendsBefore);
    expect(await countUserLedger(USER_ID)).toBe(ledgerAtLimit);
    expect((await readUserGov(USER_ID))!.is_verified).toBe(0);
  });

  it("⑧ 防毒丸：中继持续网络错误 → 同一 update 重推 MAX_ATTEMPTS 轮后 failed 收敛，再推 duplicate 200 零处理", async () => {
    // 中继所需 API 持续网络错误（throwError → client 分类 retryable → 500 重推）
    stub.always("sendMessage", { throwError: true });
    // 上限从 parseMaxAttempts(env) 动态取（vitest 钉死 "3"），与 worker 同源
    const maxAttempts = parseMaxAttempts(env);

    // 前置：⑦ 撤销了验证——模拟用户完成重验回到已验证态（毒丸场景聚焦
    // 中继失败本身），并重开限频窗口
    await env.HODOR_DB.prepare(
      `UPDATE users SET is_verified = 1, verified_at = ?, verify_answer = NULL, verify_msg_id = NULL,
       rate_window_start = NULL, rate_count = 0 WHERE bot_id = ? AND user_id = ?`,
    )
      .bind(new Date().toISOString(), BOT_ID, USER_ID)
      .run();

    const poisonUpdateId = nextUpdateId();
    const poisonUpdate = privateTextUpdate(poisonUpdateId, USER_ID, "永远中继失败的消息", 8601);
    const ledgerBefore = await countUserLedger(USER_ID);

    // 每轮失败投递：500 + 行保持 processing（失败绝不记 processed），
    // attempts 随过期接管 +1；倒填 created_at 模拟 Telegram 60s 后重推
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await postWebhook(poisonUpdate);
      expect(res.status).toBe(500);
      expect(await readProcessed(poisonUpdateId)).toEqual({
        status: "processing",
        attempts: attempt,
      });
      await backdateClaim(poisonUpdateId);
    }

    // 下一轮接管 attempts = MAX_ATTEMPTS → 毒丸：markFailed + 200，零处理
    const callsBeforePoison = stub.countOf("sendMessage");
    const poison = await postWebhook(poisonUpdate);
    expect(poison.status).toBe(200);
    expect(await readProcessed(poisonUpdateId)).toEqual({
      status: "failed",
      attempts: maxAttempts,
    });
    expect(stub.countOf("sendMessage")).toBe(callsBeforePoison);

    // failed 后再推 → duplicate 直接 200：计数与账本均不再变化（整链有界收敛）
    const replay = await postWebhook(poisonUpdate);
    expect(replay.status).toBe(200);
    expect(stub.countOf("sendMessage")).toBe(callsBeforePoison);
    expect(await readProcessed(poisonUpdateId)).toEqual({
      status: "failed",
      attempts: maxAttempts,
    });
    // 中继从未成功 → 零新账本
    expect(await countUserLedger(USER_ID)).toBe(ledgerBefore);
  });

  it("⑨ 版本一致：/health 与 /selfcheck（getWebhookInfo 指向本 worker）version 相等且 === VERSION 模块", async () => {
    stub.always("getWebhookInfo", {
      status: 200,
      json: { ok: true, result: { url: "https://example.com/webhook" } },
    });

    const health = await SELF.fetch("https://example.com/health");
    expect(health.status).toBe(200);
    // 轻量探针字节级契约（health.test.ts 同款严格断言）
    const healthText = await health.text();
    expect(healthText).toBe(JSON.stringify({ status: "ok", version: VERSION }));
    const healthVersion = JSON.parse(healthText).version;

    // /selfcheck：env（钉死全合法）+ 七表（已迁移）+ webhook（桩指向正确）全过
    const check = await SELF.fetch("https://example.com/selfcheck");
    expect(check.status).toBe(200);
    const checkBody = (await check.json()) as { status: string; version: string };
    expect(checkBody.status).toBe("ok");
    // T08 同源保证的回归固化：两端点 version 逐字相等，且都来自构建时
    // 注入的 VERSION 模块（package.json → src/generated/version.ts）
    expect(checkBody.version).toBe(healthVersion);
    expect(checkBody.version).toBe(VERSION);
  });
});
