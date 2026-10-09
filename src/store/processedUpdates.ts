/**
 * processed_updates 表 store —— 幂等认领状态机（design.md 逐字执行）。
 *
 * Telegram webhook 是至少一次投递，同一 update 可能并发 / 重复推送：
 * - 先 SELECT 快速路径：既有行 processed / failed → 重放，duplicate 直接跳过
 * - 再走原子 upsert 认领（D1 支持 RETURNING）：
 *     新 (bot_id, update_id)           → 新插入 attempts=0     → owned
 *     既有行非在途（已标记终态前不可能走到这——SELECT 已挡住，防御式）或
 *     在途但已过期（崩溃残留）          → 接管 attempts+1      → owned
 *     既有行在途且未过期                → 无返回行             → in-flight（并发去重）
 * - 接管后 attempts ≥ maxAttempts → poison：调用方 markFailed + 200（毒丸跳过）
 *
 * 占位是 processing 而非 processed：处理成功才 markProcessed，
 * 绝不提前标记掩盖失败（p1.md 警示）。
 */
import { isoBefore, nowIso } from "./util";

/** 认领过期窗口：processing 行超过该时长视为崩溃残留，可被接管（webhook 处理秒级） */
export const STALE_CLAIM_MS = 60_000;

/** 认领结果判别联合：M2 webhook 层据此直接映射 200 / 500 */
export type ClaimDecision =
  | { decision: "duplicate" }
  | { decision: "in-flight" }
  | { decision: "owned"; attempts: number }
  | { decision: "poison"; attempts: number };

/**
 * 原子认领一条 update。
 *
 * @returns
 * - duplicate：已 processed / failed（重放），调用方直接 200
 * - in-flight：并发同 id 在途且未过期，调用方 500 交由 Telegram 稍后重推
 * - owned：本请求持有处理权（新插入 attempts=0，或接管 attempts=n+1）
 * - poison：owned 且 attempts ≥ maxAttempts，调用方 markFailed + 200 跳过
 */
export async function claimUpdate(
  db: D1Database,
  params: { botId: number; updateId: number; maxAttempts: number },
): Promise<ClaimDecision> {
  const { botId, updateId, maxAttempts } = params;

  // ① SELECT 快速路径：终态行（processed/failed）直接判重
  const existing = await db
    .prepare("SELECT status FROM processed_updates WHERE bot_id = ? AND update_id = ?")
    .bind(botId, updateId)
    .first<{ status: string }>();
  if (existing && (existing.status === "processed" || existing.status === "failed")) {
    return { decision: "duplicate" };
  }

  // ② 原子 upsert 认领（design.md SQL 逐字）：
  //    WHERE 保证只在「非在途」或「在途但已过期」时接管，否则零行返回
  //
  //    部分成功窗口（design.md 明示的已知代价，p1.md 警示的行为固化）：
  //    sendMessage 已送达但 markProcessed 前崩溃 → 行停在 processing →
  //    下次重推在 60s 过期接管后会**重发一次**。这是
  //    at-least-once 投递语义下「绝不提前标记」的必然代价——宁可重复送达，
  //    绝不提前标记 processed 掩盖失败而丢消息。测试
  //    test/webhook-route.test.ts「部分成功窗口」固化该行为。
  const claimed = await db
    .prepare(
      `INSERT INTO processed_updates (bot_id, update_id, status, attempts, created_at)
       VALUES (?, ?, 'processing', 0, ?)
       ON CONFLICT (bot_id, update_id) DO UPDATE SET
         status = 'processing', attempts = attempts + 1, created_at = ?
       WHERE processed_updates.status != 'processing'
          OR processed_updates.created_at < ?
       RETURNING attempts`,
    )
    .bind(botId, updateId, nowIso(), nowIso(), isoBefore(STALE_CLAIM_MS))
    .first<{ attempts: number }>();

  if (!claimed) {
    // 既有行是在途且未过期 → 并发重复投递，不持有处理权
    return { decision: "in-flight" };
  }
  if (claimed.attempts >= maxAttempts) {
    return { decision: "poison", attempts: claimed.attempts };
  }
  return { decision: "owned", attempts: claimed.attempts };
}

/** 处理成功 → 标记 processed（唯一正确的终态写入点：成功之后） */
export async function markProcessed(
  db: D1Database,
  botId: number,
  updateId: number,
): Promise<void> {
  await db
    .prepare("UPDATE processed_updates SET status = 'processed' WHERE bot_id = ? AND update_id = ?")
    .bind(botId, updateId)
    .run();
}

/** 毒丸 / 永久失败 → 标记 failed，重推到此直接 duplicate 跳过 */
export async function markFailed(
  db: D1Database,
  botId: number,
  updateId: number,
): Promise<void> {
  await db
    .prepare("UPDATE processed_updates SET status = 'failed' WHERE bot_id = ? AND update_id = ?")
    .bind(botId, updateId)
    .run();
}
