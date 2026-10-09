/**
 * users 表 store（T23 改造 + 阶段 4 门控原语 + 阶段 5 高危原语）：
 * ensureUser 三态返回与治理快照（新建 / 展示变更 / 纯活跃刷新——治理列与
 * first_seen_at 永不被 ensureUser 改写）
 * + claimNoticeSlot 原子频控（首取赢、60s 内再取输、窗口过后可再赢、行不存在 → 输）
 * + 验证态原语（setPendingVerification / markVerified 0→1 转换与幂等 / markUnverified
 * 清字段）+ setBanned + countMessageInWindow 固定窗口（首条 / 第 N 条 / 第 N+1 条
 * 拦截 / 跨窗口重置 / 并发序列语义）
 * + setRisk / claimRiskNoticeSlot（24 小时一次性提醒窗口）/ clearAllPendingVerifications。
 * 文件级隔离 D1，自播种自断言。
 *
 * 阶段 4 调整说明：ensureUser 返回值扩治理快照（isBanned / isVerified /
 * verifyAnswer / verifyMsgId + 展示列），既有 toEqual 断言按新形状更新——
 * 「三态返回 + 治理列不动」的原断言意图保留并按快照真值收紧。
 * 阶段 5 M1 调整说明：快照再扩 isRisk / verifiedAt（高危提醒与 TTL 判定的
 * 数据源），既有 toEqual 按新形状补两字段（新档默认 false / null——原
 * 「建档默认治理态」意图不变）。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  claimNoticeSlot,
  claimRiskNoticeSlot,
  clearAllPendingVerifications,
  countMessageInWindow,
  ensureUser,
  getGovernanceSnapshot,
  markUnverified,
  markVerified,
  setBanned,
  setPendingVerification,
  setRisk,
} from "../src/store/users";

const BOT_ID = 42;
const USER_ID = 7501;

interface UserRow {
  first_name: string;
  last_name: string;
  username: string;
  status: string;
  is_banned: number;
  is_verified: number;
  verified_at: string | null;
  verify_answer: number | null;
  verify_msg_id: number | null;
  rate_window_start: string | null;
  rate_count: number;
  last_notice_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

const readUser = () =>
  env.HODOR_DB.prepare(
    `SELECT first_name, last_name, username, status, is_banned, is_verified, verified_at,
       verify_answer, verify_msg_id, rate_window_start, rate_count, last_notice_at,
       first_seen_at, last_seen_at
     FROM users WHERE bot_id = ? AND user_id = ?`,
  )
    .bind(BOT_ID, USER_ID)
    .first<UserRow>();

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
});

describe("store: ensureUser 三态返回 + 治理快照", () => {
  it("无行 → INSERT：{ isNew: true, displayChanged: false }，快照为建档默认值，firstSeenAt 与库一致", async () => {
    const result = await ensureUser(env.HODOR_DB, BOT_ID, {
      id: USER_ID,
      first_name: "Alice",
      last_name: "L",
      username: "alice_hd",
    });
    expect(result.isNew).toBe(true);
    expect(result.displayChanged).toBe(false);
    // 治理快照 = 建档默认：未封禁 / 未验证 / 无题 / 非高危 / 无验证时间 + 展示列回读
    expect(result.isBanned).toBe(false);
    expect(result.isVerified).toBe(false);
    expect(result.isRisk).toBe(false);
    expect(result.verifiedAt).toBeNull();
    expect(result.verifyAnswer).toBeNull();
    expect(result.verifyMsgId).toBeNull();
    expect(result.firstName).toBe("Alice");
    expect(result.lastName).toBe("L");
    expect(result.username).toBe("alice_hd");

    const row = await readUser();
    expect(row).toMatchObject({
      first_name: "Alice",
      last_name: "L",
      username: "alice_hd",
      status: "active",
      is_banned: 0,
      is_verified: 0,
      last_notice_at: null,
    });
    // 返回值与库内建档时间一致（显式传 nowIso 的意义）
    expect(result.firstSeenAt).toBe(row!.first_seen_at);
    expect(result.firstSeenAt).toBe(row!.last_seen_at);
  });

  it("展示字段变化 → { isNew: false, displayChanged: true }，昵称缓存刷新、firstSeenAt 保留首行值", async () => {
    await env.HODOR_DB.prepare(
      "UPDATE users SET first_seen_at = '2020-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, USER_ID)
      .run();

    const result = await ensureUser(env.HODOR_DB, BOT_ID, {
      id: USER_ID,
      first_name: "新名",
      username: "new_hd",
    });
    expect(result).toEqual({
      isNew: false,
      displayChanged: true,
      firstSeenAt: "2020-01-01T00:00:00.000Z",
      isBanned: false,
      isVerified: false,
      isRisk: false, // 阶段 5 快照新字段：新档默认（原「治理默认态」意图不变）
      verifiedAt: null,
      verifyAnswer: null,
      verifyMsgId: null,
      firstName: "新名",
      lastName: "",
      username: "new_hd",
    });

    const row = await readUser();
    expect(row).toMatchObject({
      first_name: "新名",
      last_name: "", // 未携带字段归一为空串（与 from 缺省语义一致）
      username: "new_hd",
      first_seen_at: "2020-01-01T00:00:00.000Z", // 不被覆盖
    });
  });

  it("展示字段无变化 → { isNew: false, displayChanged: false }，仅刷新 last_seen_at", async () => {
    const before = await readUser();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = await ensureUser(env.HODOR_DB, BOT_ID, {
      id: USER_ID,
      first_name: "新名",
      username: "new_hd",
    });
    expect(result.isNew).toBe(false);
    expect(result.displayChanged).toBe(false);
    expect(result.firstSeenAt).toBe(before!.first_seen_at);

    const row = await readUser();
    expect(row!.last_seen_at > before!.last_seen_at).toBe(true);
    expect(row!.first_name).toBe("新名");
  });

  it("治理列在更新分支永不动：预置 is_banned=1 / pending 题后刷新展示字段，快照回读真值且库内保持", async () => {
    await env.HODOR_DB.prepare(
      `UPDATE users SET is_banned = 1, status = 'active', verify_answer = 7, verify_msg_id = 4242,
         is_risk = 1, verified_at = '2026-10-01T08:00:00.000Z' WHERE bot_id = ? AND user_id = ?`,
    )
      .bind(BOT_ID, USER_ID)
      .run();

    const result = await ensureUser(env.HODOR_DB, BOT_ID, {
      id: USER_ID,
      first_name: "又改名",
    });
    expect(result.displayChanged).toBe(true);
    // 快照回读库内治理真值（门序判定的数据来源）
    expect(result.isBanned).toBe(true);
    expect(result.verifyAnswer).toBe(7);
    expect(result.verifyMsgId).toBe(4242);
    // 阶段 5 快照新字段：is_risk / verified_at 同样顺带读出
    expect(result.isRisk).toBe(true);
    expect(result.verifiedAt).toBe("2026-10-01T08:00:00.000Z");

    const row = await readUser();
    expect(row!.is_banned).toBe(1);
    expect(row!.verify_answer).toBe(7);
    expect(row!.verify_msg_id).toBe(4242);
    expect(row!.status).toBe("active");
  });

  it("getGovernanceSnapshot：回读治理与展示列（含 isRisk / verifiedAt）；行不存在 → null", async () => {
    const snapshot = await getGovernanceSnapshot(env.HODOR_DB, BOT_ID, USER_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.isBanned).toBe(true);
    expect(snapshot!.verifyMsgId).toBe(4242);
    expect(snapshot!.isRisk).toBe(true);
    expect(snapshot!.verifiedAt).toBe("2026-10-01T08:00:00.000Z");
    expect(snapshot!.firstName).toBe("又改名");
    expect(await getGovernanceSnapshot(env.HODOR_DB, BOT_ID, 999999999)).toBeNull();
  });
});

describe("store: claimNoticeSlot 原子频控", () => {
  const SLOT_USER = 7502;

  it("新用户行（last_notice_at NULL）→ 首取赢；60s 内再取输；行不存在 → 输", async () => {
    await ensureUser(env.HODOR_DB, BOT_ID, { id: SLOT_USER, first_name: "Slot" });

    expect(await claimNoticeSlot(env.HODOR_DB, BOT_ID, SLOT_USER)).toBe(true);
    expect(await claimNoticeSlot(env.HODOR_DB, BOT_ID, SLOT_USER)).toBe(false);
    expect(await claimNoticeSlot(env.HODOR_DB, BOT_ID, SLOT_USER)).toBe(false);
    // 行不存在（防御式）：UPDATE 零行变更 = 输
    expect(await claimNoticeSlot(env.HODOR_DB, BOT_ID, 999999999)).toBe(false);
  });

  it("写旧值（> 60s 前）→ 可再赢；写未来值 → 输", async () => {
    await env.HODOR_DB.prepare(
      "UPDATE users SET last_notice_at = '2020-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, SLOT_USER)
      .run();
    expect(await claimNoticeSlot(env.HODOR_DB, BOT_ID, SLOT_USER)).toBe(true);

    await env.HODOR_DB.prepare(
      "UPDATE users SET last_notice_at = '2999-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, SLOT_USER)
      .run();
    expect(await claimNoticeSlot(env.HODOR_DB, BOT_ID, SLOT_USER)).toBe(false);
  });
});

describe("store: 验证态原语（T27/T29）", () => {
  const VERIFY_USER = 7503;

  beforeAll(async () => {
    await ensureUser(env.HODOR_DB, BOT_ID, { id: VERIFY_USER, first_name: "Verify" });
  });

  const readVerifyRow = () =>
    env.HODOR_DB.prepare(
      "SELECT is_verified, verified_at, verify_answer, verify_msg_id FROM users WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, VERIFY_USER)
      .first<{ is_verified: number; verified_at: string | null; verify_answer: number | null; verify_msg_id: number | null }>();

  const readBanFlag = () =>
    env.HODOR_DB.prepare("SELECT is_banned FROM users WHERE bot_id = ? AND user_id = ?")
      .bind(BOT_ID, VERIFY_USER)
      .first<{ is_banned: number }>();

  it("setPendingVerification：写题目字段（answer + 题面 msgId，供判卷与归属判定）", async () => {
    await setPendingVerification(env.HODOR_DB, BOT_ID, VERIFY_USER, { answer: 7, msgId: 4242 });
    expect(await readVerifyRow()).toEqual({
      is_verified: 0,
      verified_at: null,
      verify_answer: 7,
      verify_msg_id: 4242,
    });
  });

  it("markVerified：0→1 转换返回 true，verified_at 落值、题目字段清空；重复调用返回 false（幂等重放可辨）", async () => {
    expect(await markVerified(env.HODOR_DB, BOT_ID, VERIFY_USER)).toBe(true);
    const row = await readVerifyRow();
    expect(row!.is_verified).toBe(1);
    expect(row!.verified_at).not.toBeNull();
    expect(row!.verify_answer).toBeNull();
    expect(row!.verify_msg_id).toBeNull();

    // 重放（并发第二次 / 已清空后的重推）：WHERE is_verified=0 不再命中
    expect(await markVerified(env.HODOR_DB, BOT_ID, VERIFY_USER)).toBe(false);
    expect((await readVerifyRow())!.verified_at).not.toBeNull();
  });

  it("markUnverified：撤验证 + 清 verified_at 与题目字段（超限重验 / 阶段 6 archive 复用）", async () => {
    await setPendingVerification(env.HODOR_DB, BOT_ID, VERIFY_USER, { answer: 9, msgId: 5000 });
    await markUnverified(env.HODOR_DB, BOT_ID, VERIFY_USER);
    expect(await readVerifyRow()).toEqual({
      is_verified: 0,
      verified_at: null,
      verify_answer: null,
      verify_msg_id: null,
    });
  });

  it("setBanned：封禁 / 解禁切换（/ban /unban 的唯一写入口）", async () => {
    await setBanned(env.HODOR_DB, BOT_ID, VERIFY_USER, true);
    expect((await readBanFlag())!.is_banned).toBe(1);
    await setBanned(env.HODOR_DB, BOT_ID, VERIFY_USER, false);
    expect((await readBanFlag())!.is_banned).toBe(0);
  });
});

describe("store: countMessageInWindow 固定窗口（T29）", () => {
  const RATE_USER = 7504;
  const LIMIT = 3;

  beforeAll(async () => {
    await ensureUser(env.HODOR_DB, BOT_ID, { id: RATE_USER, first_name: "Rate" });
  });

  const readRateRow = () =>
    env.HODOR_DB.prepare(
      "SELECT rate_window_start, rate_count FROM users WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, RATE_USER)
      .first<{ rate_window_start: string | null; rate_count: number }>();

  it("首条：NULL 窗口 → 重置并计数 1，放行；窗口内第 2..N 条放行且计数递增；第 N+1 条拦截且计数不动", async () => {
    // 窗口内序列语义（串行调用即真实投递序列；单语句原子性保证并发下同收敛）
    expect(await countMessageInWindow(env.HODOR_DB, BOT_ID, RATE_USER, LIMIT)).toBe(true);
    let row = await readRateRow();
    expect(row!.rate_count).toBe(1);
    expect(row!.rate_window_start).not.toBeNull();

    expect(await countMessageInWindow(env.HODOR_DB, BOT_ID, RATE_USER, LIMIT)).toBe(true);
    expect(await countMessageInWindow(env.HODOR_DB, BOT_ID, RATE_USER, LIMIT)).toBe(true);
    expect((await readRateRow())!.rate_count).toBe(3);

    // 第 N+1 条（limit=3 的第 4 条）：changes=0 → 拦截，计数停在 3
    expect(await countMessageInWindow(env.HODOR_DB, BOT_ID, RATE_USER, LIMIT)).toBe(false);
    expect(await countMessageInWindow(env.HODOR_DB, BOT_ID, RATE_USER, LIMIT)).toBe(false);
    expect((await readRateRow())!.rate_count).toBe(3);
  });

  it("跨窗口（rate_window_start ≥ 60s 前）→ 重置为 1 并恢复放行", async () => {
    await env.HODOR_DB.prepare(
      "UPDATE users SET rate_window_start = ?, rate_count = ? WHERE bot_id = ? AND user_id = ?",
    )
      .bind(new Date(Date.now() - 61_000).toISOString(), LIMIT, BOT_ID, RATE_USER)
      .run();

    expect(await countMessageInWindow(env.HODOR_DB, BOT_ID, RATE_USER, LIMIT)).toBe(true);
    const row = await readRateRow();
    expect(row!.rate_count).toBe(1);
    expect(row!.rate_window_start! > new Date(Date.now() - 61_000).toISOString()).toBe(true);
  });

  it("未来窗口（时钟偏移防御）：不重置、照常计数至上限后拦截", async () => {
    // 预置未来窗口起点 + 计数 2（= limit-1）：首条放行至 3，随后拦截且窗口不被未来值卡死重置
    await env.HODOR_DB.prepare(
      "UPDATE users SET rate_window_start = ?, rate_count = ? WHERE bot_id = ? AND user_id = ?",
    )
      .bind(new Date(Date.now() + 60_000).toISOString(), LIMIT - 1, BOT_ID, RATE_USER)
      .run();
    expect(await countMessageInWindow(env.HODOR_DB, BOT_ID, RATE_USER, LIMIT)).toBe(true);
    expect((await readRateRow())!.rate_count).toBe(LIMIT);
    expect(await countMessageInWindow(env.HODOR_DB, BOT_ID, RATE_USER, LIMIT)).toBe(false);
  });
});

describe("store: setRisk 窗口重置与 claimRiskNoticeSlot 24h 原子窗口（T37）", () => {
  const RISK_USER = 7505;

  beforeAll(async () => {
    await ensureUser(env.HODOR_DB, BOT_ID, { id: RISK_USER, first_name: "Risk" });
  });

  const readRiskRow = () =>
    env.HODOR_DB.prepare(
      "SELECT is_risk, risk_notice_at FROM users WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, RISK_USER)
      .first<{ is_risk: number; risk_notice_at: string | null }>();

  it("非高危恒输：未标记前 claim 不赢、不落 risk_notice_at；行不存在 → 输", async () => {
    expect(await claimRiskNoticeSlot(env.HODOR_DB, BOT_ID, RISK_USER)).toBe(false);
    expect((await readRiskRow())!.risk_notice_at).toBeNull();
    // 行不存在（防御式）：UPDATE 零行变更 = 输
    expect(await claimRiskNoticeSlot(env.HODOR_DB, BOT_ID, 999999999)).toBe(false);
  });

  it("/risk 标记（置 1 清窗口）→ 首条赢；24 小时内再 claim 恒输", async () => {
    await setRisk(env.HODOR_DB, BOT_ID, RISK_USER, true);
    expect((await readRiskRow())!.is_risk).toBe(1);

    expect(await claimRiskNoticeSlot(env.HODOR_DB, BOT_ID, RISK_USER)).toBe(true);
    expect((await readRiskRow())!.risk_notice_at).not.toBeNull();
    // 同窗口内（24h）再 claim：WHERE 不命中 → 输，时间戳不被刷新
    const first = (await readRiskRow())!.risk_notice_at;
    expect(await claimRiskNoticeSlot(env.HODOR_DB, BOT_ID, RISK_USER)).toBe(false);
    expect((await readRiskRow())!.risk_notice_at).toBe(first);
  });

  it("跨窗口（risk_notice_at ≤ 24 小时前）→ 再赢；写未来值 → 输", async () => {
    await env.HODOR_DB.prepare(
      "UPDATE users SET risk_notice_at = '2020-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, RISK_USER)
      .run();
    expect(await claimRiskNoticeSlot(env.HODOR_DB, BOT_ID, RISK_USER)).toBe(true);

    await env.HODOR_DB.prepare(
      "UPDATE users SET risk_notice_at = '2999-01-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, RISK_USER)
      .run();
    expect(await claimRiskNoticeSlot(env.HODOR_DB, BOT_ID, RISK_USER)).toBe(false);
  });

  it("/unrisk（置 0 一并清窗口）→ 恒输且行内无悬空窗口；/risk 重新标记重置提示窗口", async () => {
    await setRisk(env.HODOR_DB, BOT_ID, RISK_USER, false);
    expect(await readRiskRow()).toEqual({ is_risk: 0, risk_notice_at: null });
    // 取消后（即使手工残留新值）WHERE is_risk=1 不命中 → 恒输
    await env.HODOR_DB.prepare(
      "UPDATE users SET risk_notice_at = ? WHERE bot_id = ? AND user_id = ?",
    )
      .bind(new Date().toISOString(), BOT_ID, RISK_USER)
      .run();
    expect(await claimRiskNoticeSlot(env.HODOR_DB, BOT_ID, RISK_USER)).toBe(false);

    // 重新标记：setRisk 单语句同时置 is_risk=1 + 清 risk_notice_at → 下一条消息再提醒一次
    await env.HODOR_DB.prepare(
      "UPDATE users SET risk_notice_at = ? WHERE bot_id = ? AND user_id = ?",
    )
      .bind(new Date().toISOString(), BOT_ID, RISK_USER)
      .run();
    await setRisk(env.HODOR_DB, BOT_ID, RISK_USER, true);
    expect((await readRiskRow())!.risk_notice_at).toBeNull();
    expect(await claimRiskNoticeSlot(env.HODOR_DB, BOT_ID, RISK_USER)).toBe(true);
  });
});

describe("store: clearAllPendingVerifications（T32 模式切换作废旧题）", () => {
  const CLEAR_A = 7506;
  const CLEAR_B = 7507;

  beforeAll(async () => {
    await ensureUser(env.HODOR_DB, BOT_ID, { id: CLEAR_A, first_name: "CA" });
    await ensureUser(env.HODOR_DB, BOT_ID, { id: CLEAR_B, first_name: "CB" });
    // 两行各预置 pending 题 + 验证态（A 未验证带题；B 已验证但留有残留题字段的形态
    // 不该存在——此处只验证清题不动验证态，按未验证 + 带题统一播种）
    await setPendingVerification(env.HODOR_DB, BOT_ID, CLEAR_A, { answer: 3, msgId: 111 });
    await setPendingVerification(env.HODOR_DB, BOT_ID, CLEAR_B, { answer: 5, msgId: 222 });
  });

  it("一次性清空全部行的题目字段；已验证行 / 无题行不受波及；重复执行幂等", async () => {
    await env.HODOR_DB.prepare(
      "UPDATE users SET is_verified = 1, verified_at = '2026-10-01T00:00:00.000Z' WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, CLEAR_B)
      .run();

    await clearAllPendingVerifications(env.HODOR_DB);

    for (const userId of [CLEAR_A, CLEAR_B]) {
      const row = await env.HODOR_DB.prepare(
        "SELECT verify_answer, verify_msg_id FROM users WHERE bot_id = ? AND user_id = ?",
      )
        .bind(BOT_ID, userId)
        .first<{ verify_answer: number | null; verify_msg_id: number | null }>();
      expect(row).toEqual({ verify_answer: null, verify_msg_id: null });
    }
    // B 的验证态不受清题影响（题目字段与验证态互不相干）
    const verified = await env.HODOR_DB.prepare(
      "SELECT is_verified, verified_at FROM users WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, CLEAR_B)
      .first<{ is_verified: number; verified_at: string | null }>();
    expect(verified).toEqual({ is_verified: 1, verified_at: "2026-10-01T00:00:00.000Z" });

    // 幂等：无题行再执行零变更、不抛
    await clearAllPendingVerifications(env.HODOR_DB);
    const again = await env.HODOR_DB.prepare(
      "SELECT verify_answer, verify_msg_id FROM users WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, CLEAR_A)
      .first<{ verify_answer: number | null; verify_msg_id: number | null }>();
    expect(again).toEqual({ verify_answer: null, verify_msg_id: null });
  });
});
