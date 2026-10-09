/**
 * 置顶组装共享助手（阶段 5 M2，src/pipeline/pinned.ts）：
 * composePinnedText 的 verify 三态映射（默认 settings 开启 → 库内真值
 * ✅/❌；verify_enabled=0 → 恒「未启用」覆盖真值）、高危 / 备注行随库内
 * 真值组合（行序：验证 → 高危 → 备注）、users / topics 行缺失 → null、
 * overrides 强制覆盖（降级路径强制 ❌，即便 settings 关闭）。
 *
 * D1 全真（applyD1Migrations）；不涉及出站调用——纯组装层。文件内 DB
 * 共享：beforeEach 清空 settings 行，各用例从「默认 settings（无行 →
 * 开启 + 数学题）」出发，需要关闭态的用例自写 verify_enabled=0。
 * 阶段 5 新增文件。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { formatPinnedInfo } from "../src/copy";
import { composePinnedText } from "../src/pipeline/pinned";
import { upsertBot } from "../src/store/bots";
import { ensureUser } from "../src/store/users";

const BOT_ID = 42;

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
  await upsertBot(env.HODOR_DB, { botId: BOT_ID, username: "hodor_bot", displayName: "hodor" });
});

/** 每用例归一：settings 清空 → 默认（开启），需要关闭态的用例自写 */
beforeEach(async () => {
  await env.HODOR_DB.prepare("DELETE FROM settings").run();
});

/** 播种用户行（展示列定值）+ 治理位（is_verified / is_risk） */
async function seedUser(
  userId: number,
  gov: { verified?: boolean; risk?: boolean } = {},
): Promise<void> {
  await ensureUser(env.HODOR_DB, BOT_ID, {
    id: userId,
    first_name: `P${userId}`,
    last_name: "测",
    username: `u${userId}`,
  });
  await env.HODOR_DB.prepare(
    "UPDATE users SET is_verified = ?, is_risk = ? WHERE bot_id = ? AND user_id = ?",
  )
    .bind(gov.verified ? 1 : 0, gov.risk ? 1 : 0, BOT_ID, userId)
    .run();
}

/** 播种 topics 映射行（note 可选） */
async function seedTopic(userId: number, threadId: number, note: string | null = null): Promise<void> {
  await env.HODOR_DB.prepare(
    "INSERT INTO topics (bot_id, user_id, thread_id, title, note) VALUES (?, ?, ?, 'seed', ?)",
  )
    .bind(BOT_ID, userId, threadId, note)
    .run();
}

/** 期望文本：读库内 first_seen_at 后按 formatPinnedInfo 组装（与实现同构互证） */
async function expectedText(
  userId: number,
  extra: { verify: "verified" | "unverified" | "disabled"; isRisk: boolean; note: string | null },
): Promise<string> {
  const row = await env.HODOR_DB.prepare(
    "SELECT first_name, last_name, username, first_seen_at FROM users WHERE bot_id = ? AND user_id = ?",
  )
    .bind(BOT_ID, userId)
    .first<{ first_name: string; last_name: string; username: string; first_seen_at: string }>();
  return formatPinnedInfo({
    id: userId,
    first_name: row!.first_name,
    last_name: row!.last_name,
    username: row!.username,
    firstSeenAt: row!.first_seen_at,
    ...extra,
  });
}

describe("pinned: composePinnedText 三态映射（settings × 库内真值）", () => {
  it("默认 settings（无行 → 开启）+ 已验证用户 → ✅ 已验证；无高危 / 备注行", async () => {
    await seedUser(7301, { verified: true });
    await seedTopic(7301, 810);

    const text = await composePinnedText(env.HODOR_DB, BOT_ID, 7301);

    expect(text).toBe(await expectedText(7301, { verify: "verified", isRisk: false, note: null }));
    expect(text).toContain("验证状态：✅ 已验证");
    expect(text).not.toContain("高危");
    expect(text).not.toContain("备注");
  });

  it("默认 settings + 未验证用户 → ❌ 未验证（库内真值）", async () => {
    await seedUser(7302);
    await seedTopic(7302, 811);

    const text = await composePinnedText(env.HODOR_DB, BOT_ID, 7302);

    expect(text).toBe(await expectedText(7302, { verify: "unverified", isRisk: false, note: null }));
    expect(text).toContain("验证状态：❌ 未验证");
  });

  it("verify_enabled=0 → 恒「未启用」（disabled 覆盖已验证真值）；verify_mode 脏值不影响映射", async () => {
    await env.HODOR_DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('verify_enabled', '0'), ('verify_mode', 'junk')",
    ).run();
    await seedUser(7303, { verified: true });
    await seedTopic(7303, 812);

    const text = await composePinnedText(env.HODOR_DB, BOT_ID, 7303);

    expect(text).toBe(await expectedText(7303, { verify: "disabled", isRisk: false, note: null }));
    expect(text).toContain("验证状态：未启用");
  });
});

describe("pinned: composePinnedText 高危 / 备注行（库内真值组合）", () => {
  it("is_risk=1 + note 非空 → 高危行与备注行都在验证行之后（行序固定）", async () => {
    await seedUser(7304, { verified: true, risk: true });
    await seedTopic(7304, 813, "仅咨询退款");

    const text = await composePinnedText(env.HODOR_DB, BOT_ID, 7304);

    expect(text).toBe(
      await expectedText(7304, { verify: "verified", isRisk: true, note: "仅咨询退款" }),
    );
    const verifyAt = text!.indexOf("验证状态：");
    const riskAt = text!.indexOf("高危：⚠️ 高危用户");
    const noteAt = text!.indexOf("备注：仅咨询退款");
    expect(riskAt).toBeGreaterThan(verifyAt);
    expect(noteAt).toBeGreaterThan(riskAt);
  });

  it("is_risk=1 但 note 为 NULL → 高危行在、备注行不在", async () => {
    await seedUser(7305, { risk: true });
    await seedTopic(7305, 814);

    const text = await composePinnedText(env.HODOR_DB, BOT_ID, 7305);

    expect(text).toContain("高危：⚠️ 高危用户");
    expect(text).not.toContain("备注");
  });

  it("note 为空白串 → 视同无备注（formatPinnedInfo trim 契约，不产生空行）", async () => {
    await seedUser(7306);
    await seedTopic(7306, 815, "   ");

    const text = await composePinnedText(env.HODOR_DB, BOT_ID, 7306);

    expect(text).not.toContain("备注");
  });
});

describe("pinned: composePinnedText 边界与 overrides", () => {
  it("users 行缺失 / topics 行缺失 → null（无可组装真值）", async () => {
    await seedUser(7307); // 有用户无 topic
    expect(await composePinnedText(env.HODOR_DB, BOT_ID, 7307)).toBeNull();

    await seedTopic(7308, 816); // 有 topic 无用户（独立 userId）
    expect(await composePinnedText(env.HODOR_DB, BOT_ID, 7308)).toBeNull();
  });

  it("overrides 强制 verify：settings 关闭（映射「未启用」）+ 已验证 → 强制 ❌（降级路径语义）", async () => {
    await env.HODOR_DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('verify_enabled', '0')",
    ).run();
    await seedUser(7309, { verified: true, risk: true });
    await seedTopic(7309, 817, "降级场景");

    const text = await composePinnedText(env.HODOR_DB, BOT_ID, 7309, { verify: "unverified" });

    expect(text).toBe(
      await expectedText(7309, { verify: "unverified", isRisk: true, note: "降级场景" }),
    );
    expect(text).toContain("验证状态：❌ 未验证");
  });
});
