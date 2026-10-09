/**
 * 迁移 0003（users 表加 risk_notice_at 列）行为验证，对齐 migration-0002 模式：
 * 在只应用 0001+0002 的库上播种既有 users 行 → 应用 0003 → 断言新列存在、
 * 默认 NULL、存量行数据不丢。ALTER ADD COLUMN 向后兼容的直接证明
 * （正常测试文件一把应用全部迁移，无法覆盖「带着存量数据加列」的场景）。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const BOT_ID = 42;
const USER_ID = 7501;

beforeAll(async () => {
  // ① 只应用 0001 + 0002（users 尚无 risk_notice_at 列）
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS.slice(0, 2));

  // ② 旧 schema 下播种一行带全量字段的 users 数据（含验证态 / 限频 / 提示列）
  await env.HODOR_DB.prepare(
    `INSERT INTO users (bot_id, user_id, first_name, last_name, username, status, is_banned,
       is_risk, is_verified, verified_at, verify_answer, verify_msg_id, rate_window_start,
       rate_count, last_notice_at, first_seen_at, last_seen_at)
     VALUES (?, ?, '张', '三', 'zhangsan', 'active', 1, 1, 1, '2026-10-01T08:00:00.000Z',
       7, 4242, '2026-10-01T09:00:00.000Z', 3, '2026-10-01T09:30:00.000Z',
       '2026-09-01T00:00:00.000Z', '2026-10-01T09:59:00.000Z')`,
  )
    .bind(BOT_ID, USER_ID)
    .run();

  // ③ 应用 0003（ALTER 加列）
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS.slice(2, 3));
});

describe("迁移 0003：users 加 risk_notice_at 列", () => {
  it("存量行全字段原样保留（加列不丢数据）", async () => {
    const row = await env.HODOR_DB.prepare(
      `SELECT first_name, last_name, username, status, is_banned, is_risk, is_verified,
         verified_at, verify_answer, verify_msg_id, rate_window_start, rate_count,
         last_notice_at, first_seen_at, last_seen_at
       FROM users WHERE bot_id = ? AND user_id = ?`,
    )
      .bind(BOT_ID, USER_ID)
      .first();
    expect(row).toEqual({
      first_name: "张",
      last_name: "三",
      username: "zhangsan",
      status: "active",
      is_banned: 1,
      is_risk: 1,
      is_verified: 1,
      verified_at: "2026-10-01T08:00:00.000Z",
      verify_answer: 7,
      verify_msg_id: 4242,
      rate_window_start: "2026-10-01T09:00:00.000Z",
      rate_count: 3,
      last_notice_at: "2026-10-01T09:30:00.000Z",
      first_seen_at: "2026-09-01T00:00:00.000Z",
      last_seen_at: "2026-10-01T09:59:00.000Z",
    });
  });

  it("新列存在且存量行默认 NULL（从未提醒）", async () => {
    const row = await env.HODOR_DB.prepare(
      "SELECT risk_notice_at FROM users WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, USER_ID)
      .first<{ risk_notice_at: string | null }>();
    expect(row!.risk_notice_at).toBeNull();
  });

  it("新列可写入 ISO 文本（claimRiskNoticeSlot 的落点）且不影响既有列", async () => {
    await env.HODOR_DB.prepare(
      "UPDATE users SET risk_notice_at = ? WHERE bot_id = ? AND user_id = ?",
    )
      .bind("2026-10-02T10:00:00.000Z", BOT_ID, USER_ID)
      .run();
    const row = await env.HODOR_DB.prepare(
      "SELECT risk_notice_at, is_risk FROM users WHERE bot_id = ? AND user_id = ?",
    )
      .bind(BOT_ID, USER_ID)
      .first<{ risk_notice_at: string | null; is_risk: number }>();
    expect(row).toEqual({ risk_notice_at: "2026-10-02T10:00:00.000Z", is_risk: 1 });
  });
});
