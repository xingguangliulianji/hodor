/**
 * processed_updates 认领状态机全量（design.md「幂等认领状态机」逐字执行）：
 * 新建认领 / SELECT 快路径判重 / 并发在途 / 过期接管（attempts+1）/
 * MAX_ATTEMPTS 毒丸 / 终态（processed、failed）重放。
 * 迁移 0001 + 0002 在 beforeAll 一并应用（status 三值 CHECK 依赖 0002）。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  STALE_CLAIM_MS,
  claimUpdate,
  markFailed,
  markProcessed,
} from "../src/store/processedUpdates";

const BOT_ID = 42;
const MAX_ATTEMPTS = 3;

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
});

interface Row {
  status: string;
  attempts: number;
  created_at: string;
}

async function readRow(updateId: number): Promise<Row | null> {
  return env.HODOR_DB.prepare(
    "SELECT status, attempts, created_at FROM processed_updates WHERE bot_id = ? AND update_id = ?",
  )
    .bind(BOT_ID, updateId)
    .first<Row>();
}

/** 手工把行倒填到 msAgo 之前（模拟崩溃残留的过期认领） */
async function backdate(updateId: number, msAgo: number): Promise<void> {
  await env.HODOR_DB.prepare(
    "UPDATE processed_updates SET created_at = ? WHERE bot_id = ? AND update_id = ?",
  )
    .bind(new Date(Date.now() - msAgo).toISOString(), BOT_ID, updateId)
    .run();
}

function claim(updateId: number, maxAttempts = MAX_ATTEMPTS) {
  return claimUpdate(env.HODOR_DB, { botId: BOT_ID, updateId, maxAttempts });
}

describe("claim: 新建与并发", () => {
  it("全新 update → owned attempts=0，行落为 processing", async () => {
    const decision = await claim(1001);
    expect(decision).toEqual({ decision: "owned", attempts: 0 });
    expect(await readRow(1001)).toMatchObject({ status: "processing", attempts: 0 });
  });

  it("在途未过期（并发同 id）→ in-flight，不更新既有行", async () => {
    await claim(1002);
    const before = await readRow(1002);
    const decision = await claim(1002);
    expect(decision).toEqual({ decision: "in-flight" });
    // 零副作用：attempts 与 created_at 均不变
    expect(await readRow(1002)).toEqual(before);
  });

  it("不同 update_id 互不影响（bot_id, update_id) 维度隔离）", async () => {
    await claim(1003);
    const other = await claim(1004);
    expect(other).toEqual({ decision: "owned", attempts: 0 });
  });
});

describe("claim: 过期接管与 attempts 计数", () => {
  it("processing 行超 STALE_CLAIM_MS → 可接管，attempts+1，created_at 刷新", async () => {
    await claim(2001); // owned attempts=0
    await backdate(2001, STALE_CLAIM_MS + 5_000);
    const before = await readRow(2001);

    const decision = await claim(2001);
    expect(decision).toEqual({ decision: "owned", attempts: 1 });

    const after = await readRow(2001);
    expect(after).toMatchObject({ status: "processing", attempts: 1 });
    // created_at 已刷新为接管时刻（严格大于倒填值）
    expect(after!.created_at > before!.created_at).toBe(true);
  });

  it("attempts 逐次 +1 直至 ≥ MAX_ATTEMPTS → poison（行仍 processing，等调用方 markFailed）", async () => {
    let poison: { decision: string; attempts?: number } | undefined;
    let owned = 0;
    for (let i = 0; i <= MAX_ATTEMPTS; i++) {
      if (i > 0) await backdate(2002, STALE_CLAIM_MS + 5_000);
      const decision = await claim(2002);
      if (decision.decision === "owned") owned += 1;
      poison = decision;
    }
    // attempts 序列：0（新建）→1→2（接管，owned）→3（接管，poison）
    expect(owned).toBe(3);
    expect(poison).toEqual({ decision: "poison", attempts: 3 });
    expect(await readRow(2002)).toMatchObject({ status: "processing", attempts: 3 });

    await markFailed(env.HODOR_DB, BOT_ID, 2002);
    expect(await readRow(2002)).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("毒丸标记 failed 后重推 → duplicate（不再接管）", async () => {
    await env.HODOR_DB.prepare(
      "INSERT INTO processed_updates (bot_id, update_id, status, attempts) VALUES (?, 2003, 'failed', 9)",
    )
      .bind(BOT_ID)
      .run();
    const decision = await claim(2003);
    expect(decision).toEqual({ decision: "duplicate" });
    expect(await readRow(2003)).toMatchObject({ status: "failed", attempts: 9 });
  });
});

describe("claim: 终态重放（SELECT 快速路径）", () => {
  it("markProcessed 后重推 → duplicate，行保持 processed", async () => {
    await claim(3001);
    await markProcessed(env.HODOR_DB, BOT_ID, 3001);
    expect(await claim(3001)).toEqual({ decision: "duplicate" });
    expect(await readRow(3001)).toMatchObject({ status: "processed", attempts: 0 });
  });

  it("markFailed 后重推 → duplicate", async () => {
    await claim(3002);
    await markFailed(env.HODOR_DB, BOT_ID, 3002);
    expect(await claim(3002)).toEqual({ decision: "duplicate" });
    expect(await readRow(3002)).toMatchObject({ status: "failed" });
  });
});

describe("claim: maxAttempts 边界", () => {
  it("maxAttempts=1：首次接管即 poison", async () => {
    await claim(4001, 1); // 新建 owned attempts=0
    await backdate(4001, STALE_CLAIM_MS + 5_000);
    expect(await claim(4001, 1)).toEqual({ decision: "poison", attempts: 1 });
  });
});
