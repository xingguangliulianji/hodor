/**
 * 验证管线（T27）：generateQuestion 纯函数（注入 rng 确定性断言：值域 / 算式
 * 一致性 / 选项互异含答案 / 乱序）+ sendVerificationCode（先送达后落库 /
 * retryable 抛不落库 / permanent 吞不落库 / 超限合并文案含 limit）+
 * handleVerifyCallback 四路径（答对全链含置顶 ✅ 刷新 / 答错原位重出同 msgId /
 * 旧题失效 / 他人或重放失效）+ 毒丸防护（非 v:<n> 载荷零调用）+ 失败语义
 * （markVerified DB 真值先行；answerCb / edit retryable 抛、permanent warn）。
 *
 * 阶段 5 M3 新增（T32 模式化）：button 出题（单按钮 v:0 + answer=0 落库 /
 * overflow 限频前缀变体文案）、button 判卷通过链（点击 → markVerified →
 * 题面编辑 → 置顶 ✅）、模式切换后旧题回调失效（clearAllPendingVerifications
 * + 归属判定）、答错重出随当前模式（math 回归 + button 防御路径）。
 *
 * 阶段 4 新增文件。D1 全真（applyD1Migrations）+ telegramFetchStub 拦截出站。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  formatPinnedInfo,
  formatRateLimitVerifyButton,
  formatVerifyButtonQuestion,
  VERIFY_BUTTON_LABEL,
  VERIFY_EXPIRED_NOTICE,
  VERIFY_PASSED_TEXT,
  VERIFY_PASSED_TOAST,
  VERIFY_RETRY_PREFIX,
  VERIFY_WRONG_TOAST,
} from "../src/copy";
import type { TelegramCallbackQueryRef } from "../src/pipeline/classify";
import {
  buttonKeyboard,
  generateQuestion,
  handleVerifyCallback,
  optionsKeyboard,
  sendVerificationCode,
} from "../src/pipeline/verify";
import { upsertBot } from "../src/store/bots";
import { setVerificationMode } from "../src/store/settings";
import { clearAllPendingVerifications } from "../src/store/users";
import { insertTopic } from "../src/store/topics";
import { stubTelegramFetch, type TelegramFetchStub } from "./helpers/telegramFetchStub";

const BOT_ID = 42;
const SUPPORT_CHAT_ID = -1001234567890;

/** 顺序取值的注入 rng（喂确定性序列；耗尽后恒 0） */
function seqRng(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

/** 回调构造（默认：用户 7601 在题面消息 4242 上点 v:selected） */
function callback(
  overrides: Partial<TelegramCallbackQueryRef> = {},
): TelegramCallbackQueryRef {
  return {
    id: "cb-1",
    from: { id: 7601, first_name: "Verify" },
    message: { message_id: 4242, chat: { id: 7601, type: "private" } },
    data: "v:5",
    ...overrides,
  };
}

interface VerifyRow {
  is_verified: number;
  verified_at: string | null;
  verify_answer: number | null;
  verify_msg_id: number | null;
}
const readVerifyRow = (userId: number) =>
  env.HODOR_DB.prepare(
    "SELECT is_verified, verified_at, verify_answer, verify_msg_id FROM users WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<VerifyRow>();

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
});

describe("verify: generateQuestion（纯函数，注入 rng）", () => {
  it("rng 恒 0 → a=1,b=1,减法（a≥b 且 rng<0.5）：算式 '1 - 1 = ?'，答案 0", () => {
    const q = generateQuestion(() => 0);
    expect(q.expression).toBe("1 - 1 = ?");
    expect(q.answer).toBe(0);
  });

  it("a < b 时恒加法（避免负数答案）：rng [0.3, 0.7, ...] → 3 + 7 = ?，答案 10", () => {
    const q = generateQuestion(seqRng([0.3, 0.7]));
    expect(q.expression).toBe("3 + 7 = ?");
    expect(q.answer).toBe(10);
  });

  it("a ≥ b 且第三值 ≥ 0.5 → 加法；< 0.5 → 减法（两种算式对半）", () => {
    expect(generateQuestion(seqRng([0.8, 0.2, 0.9])).expression).toBe("8 + 2 = ?");
    expect(generateQuestion(seqRng([0.8, 0.2, 0.1])).expression).toBe("8 - 2 = ?");
  });

  it("结构性质（200 次真随机）：4 选项互异、答案在选项中、全部落在值域 [0,18]、算式与答案一致", () => {
    for (let i = 0; i < 200; i++) {
      const q = generateQuestion();
      expect(new Set(q.options).size, `iter ${i}`).toBe(4);
      expect(q.options, `iter ${i}`).toContain(q.answer);
      for (const option of q.options) {
        expect(option, `iter ${i}`).toBeGreaterThanOrEqual(0);
        expect(option, `iter ${i}`).toBeLessThanOrEqual(18);
      }
      const match = q.expression.match(/^([1-9]) ([-+]) ([1-9]) = \?$/);
      expect(match, `expression ${q.expression}`).not.toBeNull();
      const a = Number(match![1]);
      const b = Number(match![3]);
      expect(q.answer, `expression ${q.expression}`).toBe(match![2] === "-" ? a - b : a + b);
    }
  });

  it("选项顺序随 rng 变化（乱序确实生效——两组不同种子产生不同按钮序列即证）", () => {
    const orders = new Set<string>();
    for (let seed = 0; seed < 30; seed++) {
      const q = generateQuestion(seqRng([0.11, 0.37, 0.5, seed / 100, 0.9, 0.3, 0.6, 0.2, 0.8, 0.4]));
      orders.add(q.options.join(","));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it("optionsKeyboard：单行 4 按钮，callback_data 只携带所选值（v:<n>），绝无答案标记", () => {
    expect(optionsKeyboard([7, 9, 2, 12])).toEqual({
      inline_keyboard: [[
        { text: "7", callback_data: "v:7" },
        { text: "9", callback_data: "v:9" },
        { text: "2", callback_data: "v:2" },
        { text: "12", callback_data: "v:12" },
      ]],
    });
  });
});

describe("verify: sendVerificationCode（先送达后落库）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    // 7601 基准行：每用例归一（展示列定值 + 验证 / 题目字段清零；
    // setPendingVerification 只 UPDATE 不 INSERT，且各用例互不残留 pending 态）
    return env.HODOR_DB.prepare(
      `INSERT INTO users (bot_id, user_id, first_name, username, first_seen_at, last_seen_at)
       VALUES (?, 7601, 'Verify', 'verify_hd', '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z')
       ON CONFLICT (bot_id, user_id) DO UPDATE SET
         first_name = 'Verify', username = 'verify_hd',
         is_verified = 0, verified_at = NULL, verify_answer = NULL, verify_msg_id = NULL`,
    )
      .bind(BOT_ID)
      .run();
  });
  afterEach(() => {
    stub.restore();
  });

  it("送达成功 → 题面（4 按钮 + 题头文案）发用户私聊，verify_answer ∈ 选项、verify_msg_id = 题面消息 ID", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 4242 } } });

    await sendVerificationCode(env, BOT_ID, 7601, { type: "question" });

    expect(stub.countOf("sendMessage")).toBe(1);
    const body = stub.callsOf("sendMessage")[0].body as Record<string, unknown>;
    expect(body.chat_id).toBe(7601);
    // 题面 = copy 组装（题头 + 随机算式——形态断言而非硬编码随机值）
    expect(typeof body.text).toBe("string");
    expect((body.text as string)).toMatch(/^为确认你是真人，请回答下面的算术题：\n[1-9] [-+] [1-9] = \?$/);
    const buttons = (body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] })
      .inline_keyboard[0];
    expect(buttons).toHaveLength(4);
    const values = buttons.map((button) => Number(button.callback_data.slice(2)));
    expect(new Set(values).size).toBe(4);

    const row = await readVerifyRow(7601);
    expect(row!.verify_msg_id).toBe(4242);
    expect(values).toContain(row!.verify_answer);
    expect(row!.is_verified).toBe(0);
  });

  it("超限形态：文案含 limit 数字 + 题面同消息（单 push 合并）", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 4300 } } });

    await sendVerificationCode(env, BOT_ID, 7601, { type: "overflow", limit: 3 });

    const body = stub.callsOf("sendMessage")[0].body as Record<string, unknown>;
    expect((body.text as string)).toContain("每分钟最多 3 条");
    expect((body.text as string)).toMatch(/[1-9] [-+] [1-9] = \?$/);
    expect((body.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard[0]).toHaveLength(4);
    expect((await readVerifyRow(7601))!.verify_msg_id).toBe(4300);
  });

  it("send retryable → 抛出且不落库（重推重出题，旧题自然失效）", async () => {
    stub.always("sendMessage", { status: 503, json: { ok: false, description: "upstream boom" } });

    await expect(
      sendVerificationCode(env, BOT_ID, 7601, { type: "question" }),
    ).rejects.toThrow(/sendMessage/);
    expect((await readVerifyRow(7601))!.verify_msg_id).toBeNull();
  });

  it("send permanent → 静默完成且不落库（题未送达，库内不留 pending 态）", async () => {
    stub.always("sendMessage", {
      status: 403,
      json: { ok: false, error_code: 403, description: "Forbidden: bot was blocked" },
    });

    await expect(
      sendVerificationCode(env, BOT_ID, 7601, { type: "question" }),
    ).resolves.toBeUndefined();
    expect((await readVerifyRow(7601))!.verify_msg_id).toBeNull();
  });
});

describe("verify: handleVerifyCallback 答题路径", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("answerCallbackQuery", { status: 200, json: { ok: true, result: true } });
    stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 1 } } });
  });
  afterEach(() => {
    stub.restore();
  });

  /** 播种一个未验证用户 + pending 题（answer=5, msgId=4242），可选带 topic 置顶 */
  async function seedPending(options: { topic?: { threadId: number; pinnedMsgId: number } } = {}) {
    await env.HODOR_DB.prepare(
      `INSERT INTO users (bot_id, user_id, first_name, username, first_seen_at, last_seen_at, is_verified, verify_answer, verify_msg_id)
       VALUES (?, 7601, 'Verify', 'verify_hd', '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', 0, 5, 4242)
       ON CONFLICT (bot_id, user_id) DO UPDATE SET is_verified = 0, verify_answer = 5, verify_msg_id = 4242, verified_at = NULL`,
    )
      .bind(BOT_ID)
      .run();
    if (options.topic) {
      await env.HODOR_DB.prepare(
        `INSERT INTO topics (bot_id, user_id, thread_id, title, pinned_msg_id) VALUES (?, 7601, ?, 'Verify', ?)
         ON CONFLICT (bot_id, user_id) DO UPDATE SET pinned_msg_id = excluded.pinned_msg_id, status = 'open'`,
      )
        .bind(BOT_ID, options.topic.threadId, options.topic.pinnedMsgId)
        .run();
    } else {
      // 无 topic 选项 = 明确的「无绑定」前置：清掉文件内 DB 共享残留的映射行
      await env.HODOR_DB.prepare("DELETE FROM topics WHERE bot_id = ? AND user_id = ?")
        .bind(BOT_ID, 7601)
        .run();
    }
  }

  it("答对：markVerified（DB 真值先行）→ 通过 toast → 题面改通过提示 → 置顶刷新 ✅；题目字段清空", async () => {
    await seedPending({ topic: { threadId: 310, pinnedMsgId: 777 } });

    await handleVerifyCallback(env, BOT_ID, callback({ data: "v:5" }));

    // DB 流转：is_verified 0→1、verified_at 落值、题目字段清空
    const row = await readVerifyRow(7601);
    expect(row!.is_verified).toBe(1);
    expect(row!.verified_at).not.toBeNull();
    expect(row!.verify_answer).toBeNull();
    expect(row!.verify_msg_id).toBeNull();
    // toast：通过
    expect(stub.callsOf("answerCallbackQuery")[0].body).toEqual({
      callback_query_id: "cb-1",
      text: VERIFY_PASSED_TOAST,
    });
    // 题面 → 通过提示；置顶 → ✅ 已验证（两次 edit，键集精确）
    expect(stub.countOf("editMessageText")).toBe(2);
    expect(stub.callsOf("editMessageText")[0].body).toEqual({
      chat_id: 7601,
      message_id: 4242,
      text: VERIFY_PASSED_TEXT,
    });
    expect(stub.callsOf("editMessageText")[1].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_id: 777,
      text: formatPinnedInfo({
        id: 7601,
        first_name: "Verify",
        username: "verify_hd",
        firstSeenAt: "2026-09-01T10:00:00.000Z",
        verify: "verified",
      }),
    });
    expect(stub.countOf("sendMessage")).toBe(0); // 零新 push
  });

  it("答对但无 topic / 未置顶：题面改通过提示即止，置顶刷新跳过（下次 4a 自然带新值）", async () => {
    await seedPending();
    await handleVerifyCallback(env, BOT_ID, callback({ data: "v:5" }));
    expect((await readVerifyRow(7601))!.is_verified).toBe(1);
    expect(stub.countOf("editMessageText")).toBe(1);
  });

  it("答错：错误 toast + 同一题面消息原位重出新题新按钮（无新 push）+ 落库新答案（msgId 不变）", async () => {
    await seedPending();

    await handleVerifyCallback(env, BOT_ID, callback({ data: "v:3" }));

    expect(stub.callsOf("answerCallbackQuery")[0].body).toEqual({
      callback_query_id: "cb-1",
      text: VERIFY_WRONG_TOAST,
    });
    // 唯一一次 edit：同一 message_id，重出文案 + 4 新按钮
    expect(stub.countOf("editMessageText")).toBe(1);
    const edit = stub.callsOf("editMessageText")[0].body as Record<string, unknown>;
    expect(edit.chat_id).toBe(7601);
    expect(edit.message_id).toBe(4242);
    expect((edit.text as string)).toMatch(/^回答错误，请再试一次。/);
    const buttons = (edit.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard[0];
    expect(buttons).toHaveLength(4);
    // 新答案落库且在按钮选项中；题面消息 ID 不变（原位）
    const row = await readVerifyRow(7601);
    expect(row!.verify_msg_id).toBe(4242);
    expect(buttons.map((button) => Number(button.callback_data.slice(2)))).toContain(row!.verify_answer);
    expect(row!.is_verified).toBe(0);
    expect(stub.countOf("sendMessage")).toBe(0); // 绝无新 push（edit 才是重出载体）
  });

  it("答错且 edit permanent（题面已删）→ warn 吞：保留旧题判定（不落库新答案），静默完成", async () => {
    await seedPending();
    stub.always("editMessageText", {
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request: message to edit not found" },
    });

    await expect(
      handleVerifyCallback(env, BOT_ID, callback({ data: "v:3" })),
    ).resolves.toBeUndefined();
    // 屏幕题面未更新 → 库内答案不换（旧题判定自洽）
    const row = await readVerifyRow(7601);
    expect(row!.verify_answer).toBe(5);
    expect(row!.verify_msg_id).toBe(4242);
  });

  it("旧题回调（verify_msg_id 不匹配）→ 失效 toast，零 edit、零状态变更", async () => {
    await seedPending();
    // 用户点的是更早的题面消息 3000（库内 pending 为 4242）
    await handleVerifyCallback(
      env,
      BOT_ID,
      callback({ message: { message_id: 3000, chat: { id: 7601, type: "private" } }, data: "v:5" }),
    );

    expect(stub.callsOf("answerCallbackQuery")[0].body).toEqual({
      callback_query_id: "cb-1",
      text: VERIFY_EXPIRED_NOTICE,
    });
    expect(stub.countOf("editMessageText")).toBe(0);
    const row = await readVerifyRow(7601);
    expect(row).toMatchObject({ is_verified: 0, verify_answer: 5, verify_msg_id: 4242 });
  });

  it("重放 / 已清空（答题通过后再点同一题）→ 同一道失效判定拦截，不重复通过", async () => {
    await seedPending();
    await handleVerifyCallback(env, BOT_ID, callback({ data: "v:5" })); // 通过，字段清空
    const answersBefore = stub.countOf("answerCallbackQuery");
    const editsBefore = stub.countOf("editMessageText");

    await handleVerifyCallback(env, BOT_ID, callback({ data: "v:5" })); // 重放

    // 唯一新调用是失效 toast；题面 / 置顶 edit 零新增（通过提示不被失效覆盖）
    expect(stub.countOf("answerCallbackQuery")).toBe(answersBefore + 1);
    expect(stub.callsOf("answerCallbackQuery")[answersBefore].body).toMatchObject({
      text: VERIFY_EXPIRED_NOTICE,
    });
    expect(stub.countOf("editMessageText")).toBe(editsBefore);
    expect((await readVerifyRow(7601))!.is_verified).toBe(1); // 通过态不被重放翻回
  });

  it("他人代答（别人的 pending 题面消息）→ verify_msg_id 不匹配同样失效", async () => {
    await seedPending();
    await handleVerifyCallback(
      env,
      BOT_ID,
      callback({ from: { id: 7602, first_name: "Imp" }, message: { message_id: 4242, chat: { id: 7601, type: "private" } }, data: "v:5" }),
    );
    // 7602 无行（或行内题目 ≠ 4242）→ 失效；7601 的 pending 原样未动
    expect(stub.callsOf("answerCallbackQuery")[0].body).toMatchObject({ text: VERIFY_EXPIRED_NOTICE });
    expect((await readVerifyRow(7601))!.verify_msg_id).toBe(4242);
  });

  it("毒丸防护：data 非 v:<数字>（junk / x:5 / 缺失）→ 静默完成，零 API 调用、零状态变更", async () => {
    await seedPending();
    for (const bad of ["junk", "x:5", "v:abc", undefined]) {
      await handleVerifyCallback(env, BOT_ID, callback({ data: bad as string | undefined }));
    }
    expect(stub.countOf("answerCallbackQuery")).toBe(0);
    expect(stub.countOf("editMessageText")).toBe(0);
    expect((await readVerifyRow(7601))!.verify_answer).toBe(5);
  });

  it("失败语义：答对链 answerCallbackQuery retryable → 抛（DB 已 verified——重推收敛到失效分支）", async () => {
    await seedPending();
    stub.always("answerCallbackQuery", { status: 503, json: { ok: false, description: "unavailable" } });

    await expect(handleVerifyCallback(env, BOT_ID, callback({ data: "v:5" }))).rejects.toThrow(
      /answerCallbackQuery/,
    );
    // DB 真值先行：is_verified 已置 1（重推将落入失效分支——幂等收敛）
    expect((await readVerifyRow(7601))!.is_verified).toBe(1);
  });

  it("失败语义：题面 edit retryable → 抛；置顶刷新 retryable → 抛（design §四答题链一档）", async () => {
    await seedPending();
    stub.always("editMessageText", { status: 503, json: { ok: false, description: "unavailable" } });

    // 答对路径：题面改通过提示 retryable → 抛（is_verified 已 1）
    await expect(handleVerifyCallback(env, BOT_ID, callback({ data: "v:5" }))).rejects.toThrow(
      /editMessageText/,
    );
    expect((await readVerifyRow(7601))!.is_verified).toBe(1);
  });
});

describe("verify: handleVerifyCallback 置顶刷新失败语义（best-effort permanent / retryable 抛）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("answerCallbackQuery", { status: 200, json: { ok: true, result: true } });
  });
  afterEach(() => {
    stub.restore();
  });

  it("置顶刷新 permanent → warn 吞：题面通过提示已发、is_verified=1，流程完成", async () => {
    // 第 [0] 次 edit（题面）ok；第 [1] 次（置顶）403
    stub.on("editMessageText", (i) =>
      i === 0
        ? { status: 200, json: { ok: true, result: { message_id: 1 } } }
        : { status: 403, json: { ok: false, error_code: 403, description: "Forbidden" } },
    );
    await env.HODOR_DB.prepare(
      `INSERT INTO users (bot_id, user_id, first_name, first_seen_at, last_seen_at, is_verified, verify_answer, verify_msg_id)
       VALUES (?, 7603, 'Pin', '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', 0, 5, 4342)
       ON CONFLICT (bot_id, user_id) DO UPDATE SET is_verified = 0, verify_answer = 5, verify_msg_id = 4342`,
    )
      .bind(BOT_ID)
      .run();
    await insertTopic(env.HODOR_DB, { botId: BOT_ID, userId: 7603, threadId: 311, title: "Pin" });
    await env.HODOR_DB.prepare(
      "UPDATE topics SET pinned_msg_id = 778 WHERE bot_id = ? AND user_id = ?",
    ).bind(BOT_ID, 7603).run();

    await expect(
      handleVerifyCallback(env, BOT_ID, {
        id: "cb-2",
        from: { id: 7603, first_name: "Pin" },
        message: { message_id: 4342, chat: { id: 7603, type: "private" } },
        data: "v:5",
      }),
    ).resolves.toBeUndefined();
    expect((await readVerifyRow(7603))!.is_verified).toBe(1);
    expect(stub.countOf("editMessageText")).toBe(2); // 题面 + 置顶（失败被吞）
  });

  it("置顶刷新 retryable → 抛（重推收敛到失效分支——置顶可能停留旧值，design 接受的窗口）", async () => {
    stub.on("editMessageText", (i) =>
      i === 0
        ? { status: 200, json: { ok: true, result: { message_id: 1 } } }
        : { status: 503, json: { ok: false, description: "unavailable" } },
    );
    await env.HODOR_DB.prepare(
      `INSERT INTO users (bot_id, user_id, first_name, first_seen_at, last_seen_at, is_verified, verify_answer, verify_msg_id)
       VALUES (?, 7604, 'Pin2', '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', 0, 5, 4343)
       ON CONFLICT (bot_id, user_id) DO UPDATE SET is_verified = 0, verify_answer = 5, verify_msg_id = 4343`,
    )
      .bind(BOT_ID)
      .run();
    await insertTopic(env.HODOR_DB, { botId: BOT_ID, userId: 7604, threadId: 312, title: "Pin2" });
    await env.HODOR_DB.prepare(
      "UPDATE topics SET pinned_msg_id = 779 WHERE bot_id = ? AND user_id = ?",
    ).bind(BOT_ID, 7604).run();

    await expect(
      handleVerifyCallback(env, BOT_ID, {
        id: "cb-3",
        from: { id: 7604, first_name: "Pin2" },
        message: { message_id: 4343, chat: { id: 7604, type: "private" } },
        data: "v:5",
      }),
    ).rejects.toThrow(/editMessageText/);
    expect((await readVerifyRow(7604))!.is_verified).toBe(1); // DB 真值先行
  });
});

describe("verify: 纯按钮模式出题与判卷（T32，阶段 5 M3）", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
    stub.always("answerCallbackQuery", { status: 200, json: { ok: true, result: true } });
    stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 1 } } });
    // settings 表文件内共享：每用例归位默认（无行 = math / enabled——
    // 供既有 describe 的「阶段 4 零改动」用例维持缺省前提）
    return env.HODOR_DB.prepare("DELETE FROM settings").run();
  });
  afterEach(() => {
    stub.restore();
    return env.HODOR_DB.prepare("DELETE FROM settings").run();
  });

  /** 播种 7605 基准行（题目字段可配；默认归零） */
  async function seedUser(options: { answer?: number; msgId?: number } = {}): Promise<void> {
    await env.HODOR_DB.prepare(
      `INSERT INTO users (bot_id, user_id, first_name, username, first_seen_at, last_seen_at, is_verified, verified_at, verify_answer, verify_msg_id)
       VALUES (?, 7605, 'Btn', 'btn_hd', '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', 0, NULL, ?, ?)
       ON CONFLICT (bot_id, user_id) DO UPDATE SET
         is_verified = 0, verified_at = NULL, verify_answer = ?, verify_msg_id = ?`,
    )
      .bind(BOT_ID, options.answer ?? null, options.msgId ?? null, options.answer ?? null, options.msgId ?? null)
      .run();
  }

  /** 7605 在题面消息 4242 上点 v:<data> 的回调构造（本组用户号段） */
  function btnCallback(data: string): TelegramCallbackQueryRef {
    return {
      id: "cb-btn",
      from: { id: 7605, first_name: "Btn" },
      message: { message_id: 4242, chat: { id: 7605, type: "private" } },
      data,
    };
  }

  it("button 出题（新题形态）：单按钮「我不是机器人」v:0、题面为按钮引导文案、answer=0 落库", async () => {
    await setVerificationMode(env.HODOR_DB, "button");
    await seedUser();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 4500 } } });

    await sendVerificationCode(env, BOT_ID, 7605, { type: "question" });

    expect(stub.countOf("sendMessage")).toBe(1);
    const body = stub.callsOf("sendMessage")[0].body as Record<string, unknown>;
    expect(body.chat_id).toBe(7605);
    expect(body.text).toBe(formatVerifyButtonQuestion());
    expect(body.reply_markup).toEqual(buttonKeyboard());
    // 单按钮形态逐字段：唯一选项即唯一合法答案（v:0），载荷无答案标记
    expect(body.reply_markup).toEqual({
      inline_keyboard: [[{ text: VERIFY_BUTTON_LABEL, callback_data: "v:0" }]],
    });
    const row = await readVerifyRow(7605);
    expect(row!.verify_answer).toBe(0); // button 恒 0
    expect(row!.verify_msg_id).toBe(4500);
    expect(row!.is_verified).toBe(0);
  });

  it("button 出题（overflow 形态）：保留「发送过快…每分钟最多 {limit} 条」前缀 + 按钮题面（同消息单 push）", async () => {
    await setVerificationMode(env.HODOR_DB, "button");
    await seedUser();
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 4501 } } });

    await sendVerificationCode(env, BOT_ID, 7605, { type: "overflow", limit: 5 });

    const body = stub.callsOf("sendMessage")[0].body as Record<string, unknown>;
    expect(body.text).toBe(formatRateLimitVerifyButton(5));
    expect((body.text as string)).toContain("每分钟最多 5 条");
    expect((body.text as string)).toContain("点击下方按钮");
    expect(body.reply_markup).toEqual(buttonKeyboard());
    expect((await readVerifyRow(7605))!.verify_answer).toBe(0);
    expect((await readVerifyRow(7605))!.verify_msg_id).toBe(4501);
  });

  it("button 判卷通过链：点 v:0 → markVerified（DB 真值先行）→ 通过 toast → 题面编辑 → 置顶刷新 ✅", async () => {
    // pending 题 answer=0（button 产物形态）；settings 保持 math 不影响判卷——
    // 判卷只看「selected === 库内 verify_answer」，与模式正交
    await seedUser({ answer: 0, msgId: 4242 });
    await env.HODOR_DB.prepare(
      `INSERT INTO topics (bot_id, user_id, thread_id, title, pinned_msg_id) VALUES (?, 7605, 315, 'Btn', 780)
       ON CONFLICT (bot_id, user_id) DO UPDATE SET pinned_msg_id = 780, status = 'open'`,
    )
      .bind(BOT_ID)
      .run();

    await handleVerifyCallback(env, BOT_ID, btnCallback("v:0"));

    const row = await readVerifyRow(7605);
    expect(row!.is_verified).toBe(1);
    expect(row!.verified_at).not.toBeNull();
    expect(row!.verify_answer).toBeNull();
    expect(row!.verify_msg_id).toBeNull();
    expect(stub.callsOf("answerCallbackQuery")[0].body).toEqual({
      callback_query_id: "cb-btn",
      text: VERIFY_PASSED_TOAST,
    });
    // 题面 → 通过提示；置顶 → ✅ 已验证（键集精确）
    expect(stub.countOf("editMessageText")).toBe(2);
    expect(stub.callsOf("editMessageText")[0].body).toEqual({
      chat_id: 7605,
      message_id: 4242,
      text: VERIFY_PASSED_TEXT,
    });
    expect(stub.callsOf("editMessageText")[1].body).toEqual({
      chat_id: SUPPORT_CHAT_ID,
      message_id: 780,
      text: formatPinnedInfo({
        id: 7605,
        first_name: "Btn",
        username: "btn_hd",
        firstSeenAt: "2026-09-01T10:00:00.000Z",
        verify: "verified",
      }),
    });
    expect(stub.countOf("sendMessage")).toBe(0); // 零新 push
  });

  it("模式切换后旧题回调失效：/verifymode 序列（清题 + 切 button）后点旧数学题 → 「题目已失效」，零 edit、零状态变更", async () => {
    // 播种 math 时代的 pending 题（answer=5, msgId=4242）——随后执行与
    // /verifymode 完全相同的两步序列
    await seedUser({ answer: 5, msgId: 4242 });
    await clearAllPendingVerifications(env.HODOR_DB);
    await setVerificationMode(env.HODOR_DB, "button");

    // 用户点旧题上的「正确答案」按钮——归属判定（verify_msg_id 单道检查）
    // 拦下：库内题目字段已清空，绝不误通过
    await handleVerifyCallback(env, BOT_ID, btnCallback("v:5"));

    expect(stub.callsOf("answerCallbackQuery")[0].body).toEqual({
      callback_query_id: "cb-btn",
      text: VERIFY_EXPIRED_NOTICE,
    });
    expect(stub.countOf("editMessageText")).toBe(0);
    expect(stub.countOf("sendMessage")).toBe(0);
    expect(await readVerifyRow(7605)).toMatchObject({ is_verified: 0, verify_answer: null, verify_msg_id: null });
  });

  it("答错重出随当前模式（button 防御路径）：脏态 pending（answer≠0）点错 → 重试前缀 + 按钮题面 + 单按钮 v:0，answer 归 0（msgId 不变）", async () => {
    // button 模式下正确答案恒 0 且唯一按钮即 v:0——本分支正常不可达；
    // 人为播种 answer=5 的脏态验证防御路径自洽：重出后收敛为合法 button 题
    await setVerificationMode(env.HODOR_DB, "button");
    await seedUser({ answer: 5, msgId: 4242 });

    await handleVerifyCallback(env, BOT_ID, btnCallback("v:3"));

    expect(stub.callsOf("answerCallbackQuery")[0].body).toEqual({
      callback_query_id: "cb-btn",
      text: VERIFY_WRONG_TOAST,
    });
    // 唯一一次 edit：同一 message_id，重试前缀 + 按钮题面 + 单按钮 v:0
    expect(stub.countOf("editMessageText")).toBe(1);
    const edit = stub.callsOf("editMessageText")[0].body as Record<string, unknown>;
    expect(edit.chat_id).toBe(7605);
    expect(edit.message_id).toBe(4242);
    expect(edit.text).toBe(`${VERIFY_RETRY_PREFIX}${formatVerifyButtonQuestion()}`);
    expect(edit.reply_markup).toEqual(buttonKeyboard());
    // 落库收敛：answer=0（按钮点击即过）、msgId 原位
    expect(await readVerifyRow(7605)).toMatchObject({ is_verified: 0, verify_answer: 0, verify_msg_id: 4242 });
    expect(stub.countOf("sendMessage")).toBe(0);
  });
});
