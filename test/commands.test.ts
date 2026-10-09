/**
 * 命令管线集成（T34 /help + T35 /ban /unban + T36/T37 note / risk 组，
 * 经 handleOutbound 全链入口）：管理员 `/` 开头文本 → 命令分流——一律回
 * 当前 topic（管理员可见）、**零用户侧消息、零 messages 账本、永不中继**；
 * /help 内容（formatHelpText 默认形态原文）与 @bot 后缀 / 参数容忍；
 * /ban /unban 状态流转（is_banned 0/1）+ topic 确认（携带目标用户 ID）+
 * DB 真值先行（确认回复失败不翻转状态）；closed topic 同样可操作（治理
 * 不依赖 open——区别于中继的 closed 视同未绑定）；无绑定 → 复用 T26 提示；
 * 未知命令 → 引导 /help；非管理员 `/` 命令回「仅管理员可用」提示（真机
 * 验收增量，原静默；非命令文本仍静默）；解禁后恢复正常门序（未验证用户
 * 回到验证门）。
 *
 * 阶段 5 M2 新增：/note（写入 / 空参用法提示 / 500 码点截断 / 置顶即时
 * 刷新含备注行）、/unnote（清空 + 备注行消失）、/risk /unrisk（is_risk
 * 翻转 + risk_notice_at 窗口重置 + 置顶高危行增删）、四命令无绑定 → T26
 * 提示、置顶刷新 best-effort（edit permanent 失败不炸确认）。
 *
 * 阶段 5 M3 新增（T31/T32）：/verifyon /verifyoff（全局命令、settings 翻转、
 * 幂等 + 确认文案）、/verifymode（循环切换 + 切换清题 + button 弱防护确认）、
 * /help 接库内 settings 真值（开关两态 + 模式两态）、三命令零中继零账本。
 *
 * ADMIN_IDS = "111111111,222222222"（vitest.config.ts）；出站经
 * telegramFetchStub 拦截，无真实网络。阶段 4 新增文件。
 *
 * 阶段 5 调整说明：HELP_TEXT 常量已改 formatHelpText(settings)——M3 起
 * /help 接库内 settings 真值；本文件的既有 /help 断言以「settings 无行 =
 * 默认开 + math」为前提（新增 describe 的 beforeEach/afterEach 清空
 * settings 表保证该前提），原「/help 原文回 topic」断言意图保留。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BAN_NOTICE,
  formatBanConfirmed,
  formatHelpText,
  formatNoteConfirmed,
  formatRiskConfirmed,
  formatUnbanConfirmed,
  formatUnnoteConfirmed,
  formatUnriskConfirmed,
  formatVerifyModeConfirmed,
  formatVerifyOffConfirmed,
  formatVerifyOnConfirmed,
  formatPinnedInfo,
  NOT_ADMIN_COMMAND_NOTICE,
  NOTE_USAGE_NOTICE,
  UNBOUND_TOPIC_NOTICE,
  UNKNOWN_COMMAND_NOTICE,
} from "../src/copy";
import { handleOutbound } from "../src/pipeline/outbound";
import { handleInbound } from "../src/pipeline/inbound";
import type { TelegramMessageRef } from "../src/pipeline/classify";
import { upsertBot } from "../src/store/bots";
import {
  getVerificationSettings,
  setVerificationEnabled,
  setVerificationMode,
} from "../src/store/settings";
import { ensureUser } from "../src/store/users";
import { stubTelegramFetch, type TelegramFetchStub, type StubbedCall } from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const SUPPORT_CHAT_ID = -1001234567890;
const ADMIN_ID = 111111111;

/** M1：/help 帮助原文（默认 settings——开 + 数学题；M3 起随库内 settings 变化） */
const HELP_TEXT = formatHelpText({ verifyEnabled: true, verifyMode: "math" });

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

/** 播种用户行 + topic 绑定（status 可选 closed——命令对 closed 同样可操作；
 *  pinnedMsgId 可选——置顶刷新用例需要既有置顶消息） */
async function seedBinding(
  userId: number,
  threadId: number,
  status = "open",
  pinnedMsgId: number | null = null,
): Promise<void> {
  await ensureUser(env.HODOR_DB, BOT_ID, { id: userId, first_name: `U${userId}` });
  await env.HODOR_DB.prepare(
    "INSERT INTO topics (bot_id, user_id, thread_id, title, status, pinned_msg_id) VALUES (?, ?, ?, 'seed', ?, ?)",
  )
    .bind(BOT_ID, userId, threadId, status, pinnedMsgId)
    .run();
}

const readBanned = (userId: number) =>
  env.HODOR_DB.prepare("SELECT is_banned FROM users WHERE bot_id = ? AND user_id = ?")
    .bind(BOT_ID, userId)
    .first<{ is_banned: number }>()
    .then((row) => row?.is_banned);

const readNote = (userId: number) =>
  env.HODOR_DB.prepare("SELECT note FROM topics WHERE bot_id = ? AND user_id = ?")
    .bind(BOT_ID, userId)
    .first<{ note: string | null }>()
    .then((row) => row?.note ?? null);

/** users 治理位（高危命令断言用：is_risk 与 24h 提醒窗口） */
interface RiskRow {
  is_risk: number;
  risk_notice_at: string | null;
}
const readRisk = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT is_risk, risk_notice_at FROM users WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<RiskRow>();

const countLedger = (userId: number) =>
  env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND user_id = ?")
    .bind(BOT_ID, userId)
    .first<{ n: number }>()
    .then((row) => row!.n);

/** 发到客服群 topic 的回复（命令回复的唯一合法去向） */
function topicReplies(stub: TelegramFetchStub, threadId: number): StubbedCall[] {
  return stub.callsOf("sendMessage").filter((call) => {
    const body = call.body as Record<string, unknown>;
    return body.chat_id === SUPPORT_CHAT_ID && body.message_thread_id === threadId;
  });
}

/** 发往用户私聊的 sendMessage（中继面——命令必须恒为零） */
function userDirectCalls(stub: TelegramFetchStub, userId: number): StubbedCall[] {
  return stub.callsOf("sendMessage").filter(
    (call) => (call.body as Record<string, unknown>).chat_id === userId,
  );
}

/**
 * composePinnedText 同构期望：读库内真值（users 展示 / 治理列 + topics note
 * + settings 三态映射）按 formatPinnedInfo 组装——与 pinned.ts 实现逐字段
 * 同构，断言「置顶刷新用库内真值」而非硬编码文本。
 */
async function expectedPinnedText(userId: number): Promise<string> {
  const user = await env.HODOR_DB.prepare(
    "SELECT first_name, last_name, username, first_seen_at, is_verified, is_risk FROM users WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<{
      first_name: string;
      last_name: string;
      username: string;
      first_seen_at: string;
      is_verified: number;
      is_risk: number;
    }>();
  const topic = await env.HODOR_DB.prepare(
    "SELECT note FROM topics WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<{ note: string | null }>();
  const settings = await getVerificationSettings(env.HODOR_DB);
  return formatPinnedInfo({
    id: userId,
    first_name: user!.first_name,
    last_name: user!.last_name,
    username: user!.username,
    firstSeenAt: user!.first_seen_at,
    verify: settings.verifyEnabled
      ? user!.is_verified === 1
        ? "verified"
        : "unverified"
      : "disabled",
    isRisk: user!.is_risk === 1,
    note: topic?.note ?? null,
  });
}

describe("commands: /help（T34）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
  });
  afterEach(() => {
    stub.restore();
  });

  it("管理员 /help → HELP_TEXT 原文回当前 topic（精确键集）；零用户私聊、零账本——无绑定 topic 也可查看", async () => {
    // thread 640 无任何绑定行：/help 不依赖绑定
    await handleOutbound(env, BOT_ID, commandMessage("/help", 640));

    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: HELP_TEXT,
      message_thread_id: 640,
    });
    // 唯一 sendMessage 即 topic 回复：无任何发往用户私聊的调用、无账本行
    expect(topicReplies(stub, 640)).toHaveLength(1);
    const totalMessages = await env.HODOR_DB.prepare(
      "SELECT COUNT(*) AS n FROM messages",
    ).first<{ n: number }>();
    expect(totalMessages!.n).toBe(0);
  });

  it("@bot 后缀与附加参数容忍：/help@hodor_bot 现在 → 同一回复（首 token 去 @botname）", async () => {
    await handleOutbound(env, BOT_ID, commandMessage("/help@hodor_bot 现在", 641));

    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: HELP_TEXT,
      message_thread_id: 641,
    });
  });

  it("closed topic 内 /help → 同样回复（帮助不依赖绑定 / open）", async () => {
    await seedBinding(7240, 642, "closed");
    await handleOutbound(env, BOT_ID, commandMessage("/help", 642));

    expect(stub.callsOf("sendMessage")[0].body).toMatchObject({
      chat_id: SUPPORT_CHAT_ID,
      text: HELP_TEXT,
      message_thread_id: 642,
    });
  });
});

describe("commands: /ban /unban（T35）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
  });
  afterEach(() => {
    stub.restore();
  });

  it("/ban → setBanned(true) + topic 确认（携带目标用户 ID）；零用户侧消息、零账本、命令文本绝不中继", async () => {
    await seedBinding(7241, 643);

    await handleOutbound(env, BOT_ID, commandMessage("/ban", 643, ADMIN_ID, 71));

    expect(await readBanned(7241)).toBe(1);
    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatBanConfirmed(7241),
      message_thread_id: 643,
    });
    // 命令不是对话内容：零中继（无发往 7241 私聊的调用）、零账本
    expect(
      stub.callsOf("sendMessage").filter((call) => (call.body as Record<string, unknown>).chat_id === 7241),
    ).toHaveLength(0);
    expect(await countLedger(7241)).toBe(0);
  });

  it("/unban → setBanned(false) + 确认；/ban@hodor_bot 后缀同样生效", async () => {
    await seedBinding(7242, 644);
    await handleOutbound(env, BOT_ID, commandMessage("/ban@hodor_bot", 644, ADMIN_ID, 72));
    expect(await readBanned(7242)).toBe(1);

    await handleOutbound(env, BOT_ID, commandMessage("/unban", 644, ADMIN_ID, 73));

    expect(await readBanned(7242)).toBe(0);
    expect(stub.callsOf("sendMessage")[1].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatUnbanConfirmed(7242),
      message_thread_id: 644,
    });
    expect(await countLedger(7242)).toBe(0);
  });

  it("closed topic 同样可 /ban（治理操作不依赖 open——不是 T26 无绑定提示）", async () => {
    await seedBinding(7243, 645, "closed");

    await handleOutbound(env, BOT_ID, commandMessage("/ban", 645));

    expect(await readBanned(7243)).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatBanConfirmed(7243),
      message_thread_id: 645,
    });
  });

  it("无绑定 → 复用 T26 提示；users 表零变更（绝不猜测目标用户）", async () => {
    // 文件内 DB 共享：以「前后不变」而非绝对值断言零状态变更
    const bannedCount = async () =>
      (
        await env.HODOR_DB.prepare(
          "SELECT COUNT(*) AS n FROM users WHERE bot_id = ? AND is_banned = 1",
        )
          .bind(BOT_ID)
          .first<{ n: number }>()
      )?.n ?? 0;
    const before = await bannedCount();

    await handleOutbound(env, BOT_ID, commandMessage("/ban", 646));

    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: UNBOUND_TOPIC_NOTICE,
      message_thread_id: 646,
    });
    expect(await bannedCount()).toBe(before);
  });

  it("解禁后恢复正常门序（未验证用户回到验证门）：ban → 禁言提示无中继；unban → 验证题、仍无中继", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 647 } },
    });
    await seedBinding(7244, 647); // 未验证存量用户 + open 绑定

    // /ban：消息被封禁门拦截（唯一 bot→用户消息 = 禁言提示），不中继不账本
    await handleOutbound(env, BOT_ID, commandMessage("/ban", 647, ADMIN_ID, 80));
    expect(await readBanned(7244)).toBe(1);
    await handleInbound(env, BOT_ID, {
      message_id: 81,
      from: { id: 7244, first_name: "U7244" },
      chat: { id: 7244, type: "private" },
      text: "让我说话",
    });
    const toUserWhenBanned = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 7244);
    expect(toUserWhenBanned).toHaveLength(1);
    expect(toUserWhenBanned[0].body).toMatchObject({ text: BAN_NOTICE });
    expect(
      stub.callsOf("sendMessage").filter((call) => (call.body as Record<string, unknown>).message_thread_id === 647 && (call.body as Record<string, unknown>).text === "让我说话"),
    ).toHaveLength(0);
    expect(await countLedger(7244)).toBe(0);

    // /unban：确认后同一条消息回到**验证门**（未验证 → 出题，不中继）
    await handleOutbound(env, BOT_ID, commandMessage("/unban", 647, ADMIN_ID, 82));
    expect(await readBanned(7244)).toBe(0);
    // 禁言提示刚占用了本分钟 slot：倒填释放窗口，验证「回验证门」主旨
    await env.HODOR_DB.prepare(
      "UPDATE users SET last_notice_at = '2020-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7244)
      .run();
    await handleInbound(env, BOT_ID, {
      message_id: 83,
      from: { id: 7244, first_name: "U7244" },
      chat: { id: 7244, type: "private" },
      text: "验证我",
    });
    const toUserAfterUnban = stub
      .callsOf("sendMessage")
      .filter((call) => (call.body as Record<string, unknown>).chat_id === 7244);
    expect(toUserAfterUnban).toHaveLength(2); // 禁言提示 + 新验证题
    expect((toUserAfterUnban[1].body as Record<string, unknown>).reply_markup).toBeDefined();
    expect(
      stub.callsOf("sendMessage").filter((call) => (call.body as Record<string, unknown>).message_thread_id === 647 && (call.body as Record<string, unknown>).text === "验证我"),
    ).toHaveLength(0); // 未验证：仍不中继
    expect(await countLedger(7244)).toBe(0);
  });

  it("确认回复 retryable → 抛（重推重发回复）；is_banned 已先行置位（幂等 setter，重推不翻转）", async () => {
    stub.always("sendMessage", { status: 503, json: { ok: false, description: "upstream boom" } });
    await seedBinding(7245, 648);

    await expect(
      handleOutbound(env, BOT_ID, commandMessage("/ban", 648)),
    ).rejects.toThrow(/sendMessage/);
    expect(await readBanned(7245)).toBe(1); // DB 真值先行
  });

  it("确认回复 permanent → warn 吞（流程完成，不抛）", async () => {
    stub.always("sendMessage", {
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request: message thread not found" },
    });
    await seedBinding(7246, 649);

    await expect(
      handleOutbound(env, BOT_ID, commandMessage("/unban", 649)),
    ).resolves.toBeUndefined();
    expect(await readBanned(7246)).toBe(0);
  });
});

describe("commands: 未知命令与非管理员（T34）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
  });
  afterEach(() => {
    stub.restore();
  });

  it("未知命令 /foo → topic 内「未知命令」引导 /help，绝不发给用户、不中继、不账本", async () => {
    await seedBinding(7247, 650);

    await handleOutbound(env, BOT_ID, commandMessage("/foo", 650));

    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: UNKNOWN_COMMAND_NOTICE,
      message_thread_id: 650,
    });
    expect(await countLedger(7247)).toBe(0);
  });

  it("孤立 / 与客服群内误用的 /start → 同为未知命令提示（入口命令不在此形态生效）", async () => {
    await handleOutbound(env, BOT_ID, commandMessage("/", 651));
    await handleOutbound(env, BOT_ID, commandMessage("/start", 651, ADMIN_ID, 74));

    const replies = topicReplies(stub, 651);
    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      expect((reply.body as Record<string, unknown>).text).toBe(UNKNOWN_COMMAND_NOTICE);
    }
  });

  it("非管理员 / 开头（含 /ban /help）→ 回「仅管理员可用」提示恰发该 thread（验收增量：原静默改为可见反馈）；零状态变更、零账本；非管理员普通文本仍零调用", async () => {
    await seedBinding(7248, 652);

    await handleOutbound(env, BOT_ID, commandMessage("/ban", 652, 999999999));
    await handleOutbound(env, BOT_ID, commandMessage("/help", 652, 999999999));

    expect(stub.countOf("sendMessage")).toBe(2);
    for (const call of stub.callsOf("sendMessage")) {
      expect(call.body).toEqual({
        chat_id: SUPPORT_CHAT_ID,
        text: NOT_ADMIN_COMMAND_NOTICE,
        message_thread_id: 652,
      });
    }
    // 非管理员无治理权：is_banned 不变、命令文本不中继、零账本
    expect(await readBanned(7248)).toBe(0);
    expect(await countLedger(7248)).toBe(0);

    // 非管理员非命令文本：沿用阶段 3 静默（零新调用）
    await handleOutbound(env, BOT_ID, commandMessage("普通发言", 652, 999999999));
    expect(stub.countOf("sendMessage")).toBe(2);
  });
});

describe("commands: /note /unnote（T36）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 1 } } });
  });
  afterEach(() => {
    stub.restore();
  });

  it("/note <内容> → note 落库 + 置顶即时刷新（edit 文本含备注行，库内真值组装）+ topic 确认回显；零用户侧消息、零账本、零中继", async () => {
    await seedBinding(7250, 660, "open", 555);

    await handleOutbound(env, BOT_ID, commandMessage("/note 仅咨询退款", 660, ADMIN_ID, 90));

    // DB 真值先行：备注写入绑定行（topics.note，随 topic 终身保留）
    expect(await readNote(7250)).toBe("仅咨询退款");
    // 置顶刷新：edit 既有置顶消息，文本 = 库内真值组装（含备注行）
    expect(stub.countOf("editMessageText")).toBe(1);
    expect(stub.callsOf("editMessageText")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_id: 555,
      text: await expectedPinnedText(7250),
    });
    expect((stub.callsOf("editMessageText")[0].body as Record<string, unknown>).text).toContain(
      "备注：仅咨询退款",
    );
    // topic 确认（唯一 sendMessage）：回显写入的备注
    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatNoteConfirmed("仅咨询退款"),
      message_thread_id: 660,
    });
    // 命令零中继（无发往 7250 私聊的调用）、零账本
    expect(userDirectCalls(stub, 7250)).toHaveLength(0);
    expect(await countLedger(7250)).toBe(0);
  });

  it("/note 空参数（缺参 / 纯空白）→ 用法提示；note 不被误写（保持 NULL）、零置顶刷新", async () => {
    await seedBinding(7251, 661, "open", 556);

    await handleOutbound(env, BOT_ID, commandMessage("/note", 661, ADMIN_ID, 91));
    await handleOutbound(env, BOT_ID, commandMessage("/note   ", 661, ADMIN_ID, 92));

    const replies = topicReplies(stub, 661);
    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      expect((reply.body as Record<string, unknown>).text).toBe(NOTE_USAGE_NOTICE);
    }
    expect(await readNote(7251)).toBeNull(); // 绝不误写空备注
    expect(stub.countOf("editMessageText")).toBe(0);
    expect(await countLedger(7251)).toBe(0);
  });

  it("/note 超 500 码点 → 按码点截断落库（emoji 不切成乱码）；确认回显截断后的值（= 实际落库值）", async () => {
    await seedBinding(7252, 662, "open", 557);
    const longNote = "😀".repeat(502);

    await handleOutbound(env, BOT_ID, commandMessage(`/note ${longNote}`, 662, ADMIN_ID, 93));

    const note = await readNote(7252);
    expect([...note!].length).toBe(500); // 码点数（非 UTF-16 单元）
    expect(note).toBe("😀".repeat(500));
    expect((topicReplies(stub, 662)[0].body as Record<string, unknown>).text).toBe(
      formatNoteConfirmed("😀".repeat(500)),
    );
  });

  it("/unnote → 清空 note + 置顶刷新（备注行消失）+ 确认；零用户侧消息、零账本", async () => {
    await seedBinding(7253, 663, "open", 558);
    await env.HODOR_DB.prepare(
      "UPDATE topics SET note = '旧备注' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7253)
      .run();

    await handleOutbound(env, BOT_ID, commandMessage("/unnote", 663, ADMIN_ID, 94));

    expect(await readNote(7253)).toBeNull();
    expect(stub.countOf("editMessageText")).toBe(1);
    expect((stub.callsOf("editMessageText")[0].body as Record<string, unknown>).text).toBe(
      await expectedPinnedText(7253),
    );
    expect((stub.callsOf("editMessageText")[0].body as Record<string, unknown>).text).not.toContain(
      "备注",
    );
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatUnnoteConfirmed(),
      message_thread_id: 663,
    });
    expect(userDirectCalls(stub, 7253)).toHaveLength(0);
    expect(await countLedger(7253)).toBe(0);
  });

  it("closed topic 同样可操作（/note；治理不依赖 open——复刻 /ban closed 姿态，非 T26 提示）", async () => {
    await seedBinding(7254, 664, "closed", 559);

    await handleOutbound(env, BOT_ID, commandMessage("/note 已结案待复访", 664, ADMIN_ID, 95));

    expect(await readNote(7254)).toBe("已结案待复访");
    expect((topicReplies(stub, 664)[0].body as Record<string, unknown>).text).toBe(
      formatNoteConfirmed("已结案待复访"),
    );
    expect(stub.countOf("editMessageText")).toBe(1); // closed 的置顶照常刷新
  });

  it("无绑定 → 四命令均回 T26 提示；users / topics 零写入、零置顶刷新", async () => {
    const noteCount = async () =>
      (
        await env.HODOR_DB.prepare(
          "SELECT COUNT(*) AS n FROM topics WHERE bot_id = ? AND note IS NOT NULL",
        )
          .bind(BOT_ID)
          .first<{ n: number }>()
      )?.n ?? 0;
    const riskCount = async () =>
      (
        await env.HODOR_DB.prepare(
          "SELECT COUNT(*) AS n FROM users WHERE bot_id = ? AND is_risk = 1",
        )
          .bind(BOT_ID)
          .first<{ n: number }>()
      )?.n ?? 0;
    const [notesBefore, risksBefore] = [await noteCount(), await riskCount()];

    const commands = ["/note 找谁", "/unnote", "/risk", "/unrisk"];
    for (const [index, text] of commands.entries()) {
      await handleOutbound(env, BOT_ID, commandMessage(text, 665 + index, ADMIN_ID, 96 + index));
    }

    // 四条回复都是 T26 提示（绝不猜测目标用户）
    expect(stub.countOf("sendMessage")).toBe(4);
    for (const call of stub.callsOf("sendMessage")) {
      expect((call.body as Record<string, unknown>).text).toBe(UNBOUND_TOPIC_NOTICE);
    }
    expect(stub.countOf("editMessageText")).toBe(0);
    expect(await noteCount()).toBe(notesBefore);
    expect(await riskCount()).toBe(risksBefore);
  });

  it("置顶刷新 best-effort：edit permanent 失败 → warn 吞，确认照发、note 已落库（不重推）", async () => {
    stub.always("editMessageText", {
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request: message to edit not found" },
    });
    await seedBinding(7255, 669, "open", 560);

    await expect(
      handleOutbound(env, BOT_ID, commandMessage("/note 置顶已删", 669, ADMIN_ID, 100)),
    ).resolves.toBeUndefined();

    expect(await readNote(7255)).toBe("置顶已删"); // DB 真值先行
    expect(stub.countOf("editMessageText")).toBe(1); // 尝试过刷新（失败被吞）
    expect(stub.countOf("sendMessage")).toBe(1); // 确认照发
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatNoteConfirmed("置顶已删"),
      message_thread_id: 669,
    });
  });
});

describe("commands: /risk /unrisk（T37）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 1 } } });
  });
  afterEach(() => {
    stub.restore();
  });

  it("/risk → is_risk=1 + risk_notice_at 清空（24h 提醒窗口重置）+ 置顶出现高危行 + 确认；零用户侧消息、零账本、零中继", async () => {
    await seedBinding(7256, 670, "open", 561);
    // 预置历史提醒窗口：/risk 必须清掉（重新标记 → 下一条消息重新提醒一次）
    await env.HODOR_DB.prepare(
      "UPDATE users SET risk_notice_at = '2026-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, 7256)
      .run();

    await handleOutbound(env, BOT_ID, commandMessage("/risk", 670, ADMIN_ID, 101));

    expect(await readRisk(7256)).toEqual({ is_risk: 1, risk_notice_at: null });
    expect(stub.countOf("editMessageText")).toBe(1);
    expect(stub.callsOf("editMessageText")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_id: 561,
      text: await expectedPinnedText(7256),
    });
    expect((stub.callsOf("editMessageText")[0].body as Record<string, unknown>).text).toContain(
      "高危：⚠️ 高危用户",
    );
    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatRiskConfirmed(7256),
      message_thread_id: 670,
    });
    expect(userDirectCalls(stub, 7256)).toHaveLength(0);
    expect(await countLedger(7256)).toBe(0);
  });

  it("/unrisk → is_risk=0 + 置顶高危行消失 + 确认（携带目标用户 ID）", async () => {
    await seedBinding(7257, 671, "open", 562);
    await env.HODOR_DB.prepare("UPDATE users SET is_risk = 1 WHERE bot_id = ? AND user_id = ?")
      .bind(BOT_ID, 7257)
      .run();

    await handleOutbound(env, BOT_ID, commandMessage("/unrisk", 671, ADMIN_ID, 102));

    expect(await readRisk(7257)).toMatchObject({ is_risk: 0 });
    expect(stub.countOf("editMessageText")).toBe(1);
    expect((stub.callsOf("editMessageText")[0].body as Record<string, unknown>).text).toBe(
      await expectedPinnedText(7257),
    );
    expect((stub.callsOf("editMessageText")[0].body as Record<string, unknown>).text).not.toContain(
      "高危",
    );
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatUnriskConfirmed(7257),
      message_thread_id: 671,
    });
    expect(await countLedger(7257)).toBe(0);
  });

  it("无置顶（pinned NULL）→ 置顶刷新跳过（零 edit），setter 与确认照常", async () => {
    await seedBinding(7258, 672); // pinned_msg_id NULL

    await handleOutbound(env, BOT_ID, commandMessage("/risk", 672, ADMIN_ID, 103));

    expect(await readRisk(7258)).toEqual({ is_risk: 1, risk_notice_at: null });
    expect(stub.countOf("editMessageText")).toBe(0);
    expect(stub.countOf("sendMessage")).toBe(1);
    expect((stub.callsOf("sendMessage")[0].body as Record<string, unknown>).text).toBe(
      formatRiskConfirmed(7258),
    );
  });

  it("/risk@hodor_bot 后缀同样生效（首 token 去 @botname，参数照常解析）", async () => {
    await seedBinding(7259, 673, "open", 563);

    await handleOutbound(env, BOT_ID, commandMessage("/risk@hodor_bot", 673, ADMIN_ID, 104));

    expect((await readRisk(7259))!.is_risk).toBe(1);
    expect((topicReplies(stub, 673)[0].body as Record<string, unknown>).text).toBe(
      formatRiskConfirmed(7259),
    );
  });
});

describe("commands: /verifyon /verifyoff /verifymode + /help 动态（T31/T32，阶段 5 M3）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    // settings 表文件内共享：每用例前后归位默认（无行 = 开 + math），
    // 供本文件既有 /help 用例维持「默认 settings」前提
    return env.HODOR_DB.prepare("DELETE FROM settings").run();
  });
  afterEach(() => {
    stub.restore();
    return env.HODOR_DB.prepare("DELETE FROM settings").run();
  });

  /** 播种带 pending 题的用户（verify_answer / verify_msg_id 落值） */
  async function seedPendingUser(userId: number, answer: number, msgId: number): Promise<void> {
    await ensureUser(env.HODOR_DB, BOT_ID, { id: userId, first_name: `U${userId}` });
    await env.HODOR_DB.prepare(
      "UPDATE users SET verify_answer = ?, verify_msg_id = ? WHERE bot_id = ? AND user_id = ?",
    )
      .bind(answer, msgId, BOT_ID, userId)
      .run();
  }

  /** messages 总行数（文件内 DB 共享：断言「前后不变」而非绝对值） */
  const countAllLedgerRows = () =>
    env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM messages")
      .first<{ n: number }>()
      .then((row) => row!.n);

  it("/verifyoff → settings 翻转为关 + 确认（含记录保留说明）；幂等：重复执行同值无害、两次确认照发；零中继零账本", async () => {
    const before = await countAllLedgerRows();
    await handleOutbound(env, BOT_ID, commandMessage("/verifyoff", 680, ADMIN_ID, 110));

    expect((await getVerificationSettings(env.HODOR_DB)).verifyEnabled).toBe(false);
    expect(stub.countOf("sendMessage")).toBe(1);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatVerifyOffConfirmed(),
      message_thread_id: 680,
    });

    // 幂等：同值重复执行——settings 不变、确认照发（第二条也回确认）
    await handleOutbound(env, BOT_ID, commandMessage("/verifyoff", 681, ADMIN_ID, 111));
    expect((await getVerificationSettings(env.HODOR_DB)).verifyEnabled).toBe(false);
    const replies = topicReplies(stub, 681);
    expect(replies).toHaveLength(1);
    expect((replies[0].body as Record<string, unknown>).text).toBe(formatVerifyOffConfirmed());
    // 全局命令零用户侧消息（无任何私聊调用）、零账本
    expect(stub.callsOf("sendMessage").every((call) => (call.body as Record<string, unknown>).chat_id === SUPPORT_CHAT_ID)).toBe(true);
    expect(await countAllLedgerRows()).toBe(before);
  });

  it("/verifyon → settings 恢复为开 + 确认（含「已验证不受影响」）；默认开时执行同样幂等无害", async () => {
    // 关 → 开：真翻转
    await setVerificationEnabled(env.HODOR_DB, false);
    await handleOutbound(env, BOT_ID, commandMessage("/verifyon", 682, ADMIN_ID, 112));
    expect((await getVerificationSettings(env.HODOR_DB)).verifyEnabled).toBe(true);
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      text: formatVerifyOnConfirmed(),
      message_thread_id: 682,
    });

    // 开 → 开（幂等重复）：同值无害，确认照发
    await handleOutbound(env, BOT_ID, commandMessage("/verifyon", 683, ADMIN_ID, 113));
    expect((await getVerificationSettings(env.HODOR_DB)).verifyEnabled).toBe(true);
    expect((topicReplies(stub, 683)[0].body as Record<string, unknown>).text).toBe(
      formatVerifyOnConfirmed(),
    );
  });

  it("全局命令语义：无绑定 / closed topic 内 /verifyoff 照常执行（不回 T26 UNBOUND——与 /help 同姿态）", async () => {
    await seedBinding(7270, 684, "closed"); // closed 绑定行存在但全局命令不需要它

    await handleOutbound(env, BOT_ID, commandMessage("/verifyoff", 685, ADMIN_ID, 114)); // 685 无绑定
    await handleOutbound(env, BOT_ID, commandMessage("/verifyoff", 684, ADMIN_ID, 115)); // 684 closed

    const unboundReply = topicReplies(stub, 685)[0].body as Record<string, unknown>;
    expect(unboundReply.text).toBe(formatVerifyOffConfirmed()); // 绝非 UNBOUND_TOPIC_NOTICE
    expect((topicReplies(stub, 684)[0].body as Record<string, unknown>).text).toBe(
      formatVerifyOffConfirmed(),
    );
    expect(stub.countOf("sendMessage")).toBe(2); // 除两条确认外零调用（无置顶刷新——不涉绑定用户）
  });

  it("/verifymode 循环切换：math → button → math；确认携带新模式（button 附防护较弱说明、math 不附）；零中继零账本", async () => {
    const before = await countAllLedgerRows();
    expect((await getVerificationSettings(env.HODOR_DB)).verifyMode).toBe("math"); // 缺省

    await handleOutbound(env, BOT_ID, commandMessage("/verifymode", 686, ADMIN_ID, 116));
    expect((await getVerificationSettings(env.HODOR_DB)).verifyMode).toBe("button");
    const firstReply = topicReplies(stub, 686)[0].body as Record<string, unknown>;
    expect(firstReply.text).toBe(formatVerifyModeConfirmed("button"));
    expect(firstReply.text as string).toContain("防护较弱");

    await handleOutbound(env, BOT_ID, commandMessage("/verifymode", 687, ADMIN_ID, 117));
    expect((await getVerificationSettings(env.HODOR_DB)).verifyMode).toBe("math");
    const secondReply = topicReplies(stub, 687)[0].body as Record<string, unknown>;
    expect(secondReply.text).toBe(formatVerifyModeConfirmed("math"));
    expect(secondReply.text as string).not.toContain("防护较弱");

    expect(await countAllLedgerRows()).toBe(before);
  });

  it("/verifymode 切换清题：pending 用户（含多用户）题目字段被清空，已验证用户验证态不受影响", async () => {
    await seedPendingUser(7271, 5, 4242);
    await seedPendingUser(7272, 3, 4243);
    await env.HODOR_DB.prepare(
      "UPDATE users SET is_verified = 1, verified_at = ? WHERE bot_id = ? AND user_id = ?",
    )
      .bind(new Date().toISOString(), BOT_ID, 7272)
      .run();

    await handleOutbound(env, BOT_ID, commandMessage("/verifymode", 688, ADMIN_ID, 118));

    const readFields = async (userId: number) =>
      env.HODOR_DB.prepare(
        "SELECT is_verified, verify_answer, verify_msg_id FROM users WHERE bot_id = ? AND user_id = ?",
      )
        .bind(BOT_ID, userId)
        .first<{ is_verified: number; verify_answer: number | null; verify_msg_id: number | null }>();
    // 旧题一律作废（verify_answer / verify_msg_id → NULL）——旧题回调落失效分支
    expect(await readFields(7271)).toEqual({ is_verified: 0, verify_answer: null, verify_msg_id: null });
    // 已验证用户的验证态与 verified_at 语义不受切换影响（题目字段本就为空）
    expect(await readFields(7272)).toMatchObject({ is_verified: 1, verify_answer: null, verify_msg_id: null });
  });

  it("/help 动态：开关两态 × 模式两态接库内 settings 真值（关 → 含 /verifyon 不含 /verifyoff；开 → 反之；模式行随真值）", async () => {
    // 关 + math：含 /verifyon 与「当前验证已关闭」，不含 /verifyoff
    await setVerificationEnabled(env.HODOR_DB, false);
    await handleOutbound(env, BOT_ID, commandMessage("/help", 689, ADMIN_ID, 119));
    let reply = topicReplies(stub, 689)[0].body as Record<string, unknown>;
    expect(reply.text).toBe(formatHelpText({ verifyEnabled: false, verifyMode: "math" }));
    expect(reply.text as string).toContain("/verifyon");
    expect(reply.text as string).toContain("当前验证已关闭");
    expect(reply.text as string).not.toContain("/verifyoff");

    // 关 + button：模式行随真值（当前：纯按钮）
    await setVerificationMode(env.HODOR_DB, "button");
    await handleOutbound(env, BOT_ID, commandMessage("/help", 690, ADMIN_ID, 120));
    reply = topicReplies(stub, 690)[0].body as Record<string, unknown>;
    expect(reply.text).toBe(formatHelpText({ verifyEnabled: false, verifyMode: "button" }));
    expect(reply.text as string).toContain("当前：纯按钮");

    // 开 + button：含 /verifyoff 不含 /verifyon（模式行保持纯按钮）
    await setVerificationEnabled(env.HODOR_DB, true);
    await handleOutbound(env, BOT_ID, commandMessage("/help", 691, ADMIN_ID, 121));
    reply = topicReplies(stub, 691)[0].body as Record<string, unknown>;
    expect(reply.text).toBe(formatHelpText({ verifyEnabled: true, verifyMode: "button" }));
    expect(reply.text as string).toContain("/verifyoff");
    expect(reply.text as string).not.toContain("/verifyon");

    // 开 + math（回到缺省形态）：模式行「当前：数学题」
    await setVerificationMode(env.HODOR_DB, "math");
    await handleOutbound(env, BOT_ID, commandMessage("/help", 692, ADMIN_ID, 122));
    reply = topicReplies(stub, 692)[0].body as Record<string, unknown>;
    expect(reply.text).toBe(HELP_TEXT); // = formatHelpText(默认开 + math)
    expect(reply.text as string).toContain("当前：数学题");
  });
});
