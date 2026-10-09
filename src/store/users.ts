/**
 * users 表 store：用户建档、展示缓存刷新、提示频控与治理门控原语。
 *
 * T19：首条消息即建档（无需 /start，无需文本——阶段 3 起媒体同权）；
 * 每次消息刷新昵称缓存与 last_seen_at。
 * T23：claimNoticeSlot 用 last_notice_at 做「每用户每分钟最多 1 次」的
 * 提示频控（欢迎语；阶段 4 起验证码 / 禁言 / 超限提示复用同列）。
 * T27/T29/T35（阶段 4）：ensureUser 的既有 SELECT 顺带读出治理快照
 * （封禁 / 验证 / 题目字段）；验证态、封禁态与限频窗口的全部变更收口在
 * 本模块的专用原子 setter / 计数器——流水线绝不手写治理列 UPDATE。
 * T37/T32（阶段 5）：快照顺带读出 is_risk / verified_at（高危提醒与
 * TTL 判定的数据源）；setRisk / claimRiskNoticeSlot（24 小时一次性
 * 提醒窗口）；clearAllPendingVerifications（/verifymode 切换作废旧题）。
 *
 * 契约：first_seen_at 永不在本模块更新范围（建档即定死）；展示列刷新仅走
 * ensureUser；治理列变更仅走本模块 setter（单语句原子，无读-判-写竞态）。
 */
import { isoBefore, nowIso } from "./util";

/** Telegram update 里 from 的展示字段子集（缺省字段归一为空串） */
export interface UserFromFields {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/**
 * 治理快照：三门判定（封禁 / 验证）+ 答题归属（pending 题目字段）+
 * 置顶刷新所需的展示列。ensureUser 与 getGovernanceSnapshot 共用此形状。
 */
export interface GovernanceSnapshot {
  /** 封禁门：is_banned=1 → 入站一律拦截（先于验证 / 限频门） */
  isBanned: boolean;
  /** 验证门：is_verified=0 → 拦截并（按策略）出验证题 */
  isVerified: boolean;
  /**
   * 高危标记（users.is_risk）：置顶「高危」行与 topic 内 24 小时一次性
   * 提醒（claimRiskNoticeSlot）的数据源（T37）
   */
  isRisk: boolean;
  /**
   * 验证通过时间（users.verified_at）：T33 VERIFY_TTL_HOURS 过期判定用
   * （字典序比较，util 契约）；未验证 / 已撤销 → null
   */
  verifiedAt: string | null;
  /** 当前 pending 题的正确答案（users.verify_answer；无题 → null） */
  verifyAnswer: number | null;
  /** 当前 pending 题的题面消息 ID（users.verify_msg_id；无题 → null） */
  verifyMsgId: number | null;
  firstName: string;
  lastName: string;
  username: string;
  /** 建档时间（users.first_seen_at，ISO 文本）——置顶信息展示用 */
  firstSeenAt: string;
}

/** ensureUser 的返回（入站管线据此走三门与置顶 4b 刷新 / 欢迎语触发） */
export interface EnsureUserResult extends GovernanceSnapshot {
  /** 本次是否新建行（首次联系——首联包：欢迎语 + 首个验证题成对发出） */
  isNew: boolean;
  /** 展示字段（first/last/username）相对库内是否有变化（触发置顶 4b 刷新） */
  displayChanged: boolean;
}

/** 提示频控窗口：每用户每 60 秒最多赢得 1 个 notice slot（T23） */
export const NOTICE_SLOT_WINDOW_MS = 60_000;

/** 限频固定窗口长度：距 rate_window_start ≥ 60s 即重置计数（T29） */
export const RATE_WINDOW_MS = 60_000;

/** 高危提醒窗口：同一高危用户 24 小时内最多提醒 1 次（T37） */
export const RISK_NOTICE_WINDOW_MS = 24 * 3600_000;

/**
 * 建档 / 刷新用户行，返回三态结果 + 治理快照。
 *
 * 先 SELECT 现行再分支（无读-判-写竞态的代价由 claimNoticeSlot 类原子
 * 语句承担；本函数只服务单 update 内的单次调用）：
 * - 无行 → INSERT（first_seen_at 显式传 nowIso，保证返回值与库内一致）；
 *   治理快照即建档默认值（未封禁 / 未验证 / 无题）
 * - 有行且展示字段变化 → 更新昵称缓存 + last_seen_at（displayChanged=true）
 * - 有行无变化 → 仅刷新 last_seen_at
 * 治理列（is_banned / is_verified / verify_*）在两个更新分支均不触碰。
 */
export async function ensureUser(
  db: D1Database,
  botId: number,
  from: UserFromFields,
): Promise<EnsureUserResult> {
  const existing = await db
    .prepare(
      `SELECT first_name, last_name, username, first_seen_at, is_banned, is_verified,
         is_risk, verified_at, verify_answer, verify_msg_id
       FROM users WHERE bot_id = ? AND user_id = ?`,
    )
    .bind(botId, from.id)
    .first<{
      first_name: string;
      last_name: string;
      username: string;
      first_seen_at: string;
      is_banned: number;
      is_verified: number;
      is_risk: number;
      verified_at: string | null;
      verify_answer: number | null;
      verify_msg_id: number | null;
    }>();

  const firstName = from.first_name ?? "";
  const lastName = from.last_name ?? "";
  const username = from.username ?? "";

  if (!existing) {
    const now = nowIso();
    const firstSeenAt = now;
    await db
      .prepare(
        `INSERT INTO users (bot_id, user_id, first_name, last_name, username, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(botId, from.id, firstName, lastName, username, firstSeenAt, now)
      .run();
    return {
      isNew: true,
      displayChanged: false,
      firstSeenAt,
      isBanned: false,
      isVerified: false,
      isRisk: false,
      verifiedAt: null,
      verifyAnswer: null,
      verifyMsgId: null,
      firstName,
      lastName,
      username,
    };
  }

  const displayChanged =
    existing.first_name !== firstName ||
    existing.last_name !== lastName ||
    existing.username !== username;
  if (displayChanged) {
    // 原阶段 2 的 upsert 更新分支：只覆盖展示缓存与活跃时间
    await db
      .prepare(
        `INSERT INTO users (bot_id, user_id, first_name, last_name, username, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, user_id) DO UPDATE SET
           first_name = excluded.first_name,
           last_name = excluded.last_name,
           username = excluded.username,
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(botId, from.id, firstName, lastName, username, nowIso())
      .run();
  } else {
    await db
      .prepare("UPDATE users SET last_seen_at = ? WHERE bot_id = ? AND user_id = ?")
      .bind(nowIso(), botId, from.id)
      .run();
  }
  return {
    isNew: false,
    displayChanged,
    firstSeenAt: existing.first_seen_at,
    isBanned: existing.is_banned === 1,
    isVerified: existing.is_verified === 1,
    isRisk: existing.is_risk === 1,
    verifiedAt: existing.verified_at,
    verifyAnswer: existing.verify_answer,
    verifyMsgId: existing.verify_msg_id,
    // 展示列回读「写后真值」：displayChanged 分支刚把新值写入库，
    // 快照与库内保持一致（而非 SELECT 时的旧值）
    firstName,
    lastName,
    username,
  };
}

/**
 * 只读治理快照（答题回调用，无副作用）：行不存在 → null。
 * 与 ensureUser 同一列集——答题归属判定（verify_msg_id）与置顶刷新
 * （展示列 + first_seen_at）一次读齐。
 */
export async function getGovernanceSnapshot(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<GovernanceSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT first_name, last_name, username, first_seen_at, is_banned, is_verified,
         is_risk, verified_at, verify_answer, verify_msg_id
       FROM users WHERE bot_id = ? AND user_id = ?`,
    )
    .bind(botId, userId)
    .first<{
      first_name: string;
      last_name: string;
      username: string;
      first_seen_at: string;
      is_banned: number;
      is_verified: number;
      is_risk: number;
      verified_at: string | null;
      verify_answer: number | null;
      verify_msg_id: number | null;
    }>();
  if (!row) return null;
  return {
    isBanned: row.is_banned === 1,
    isVerified: row.is_verified === 1,
    isRisk: row.is_risk === 1,
    verifiedAt: row.verified_at,
    verifyAnswer: row.verify_answer,
    verifyMsgId: row.verify_msg_id,
    firstName: row.first_name,
    lastName: row.last_name,
    username: row.username,
    firstSeenAt: row.first_seen_at,
  };
}

/**
 * 原子领取提示频控 slot（T23 欢迎语频控；T30 起全部 bot → 用户提示共享）：
 * `last_notice_at IS NULL 或 ≤ 60 秒前` 才允许写入当前时间——单条 UPDATE
 * 的 WHERE 即裁决，**无读-判-写竞态**；meta.changes === 1 即赢得本分钟窗口。
 *
 * 新用户行 last_notice_at 为 NULL → 首条欢迎语天然赢；
 * 行不存在（理论上 ensureUser 先行，防御式）→ 0 行变更 = 输。
 */
export async function claimNoticeSlot(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET last_notice_at = ?
       WHERE bot_id = ? AND user_id = ? AND (last_notice_at IS NULL OR last_notice_at <= ?)`,
    )
    .bind(nowIso(), botId, userId, isoBefore(NOTICE_SLOT_WINDOW_MS))
    .run();
  return result.meta.changes === 1;
}

/**
 * 原子领取高危提醒 slot（T37）：完全复刻 claimNoticeSlot 的原子模式——
 * 单条 UPDATE 的 WHERE 即裁决，**无读-判-写竞态**；meta.changes === 1 即
 * 赢得本 24 小时窗口（赢者负责发送 topic 内提醒）。
 *
 * WHERE 额外带 `is_risk = 1`：非高危（含 /unrisk 之后）永不赢得，调用方
 * 无需先判快照；`risk_notice_at IS NULL 或 ≤ 24 小时前` 才允许写入当前
 * 时间——NULL 即「从未提醒」，首条消息天然赢。/risk 重新标记时 setter
 * 已清空本列，窗口随之重置（下一条消息再提醒一次，PRD 语义）。
 */
export async function claimRiskNoticeSlot(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET risk_notice_at = ?
       WHERE bot_id = ? AND user_id = ?
         AND is_risk = 1 AND (risk_notice_at IS NULL OR risk_notice_at <= ?)`,
    )
    .bind(nowIso(), botId, userId, isoBefore(RISK_NOTICE_WINDOW_MS))
    .run();
  return result.meta.changes === 1;
}

/**
 * 落库 pending 验证题（T27）：出题成功送达后写入 answer + 题面 msgId。
 * 供出题 / 答错原位重出（同 msgId 换新答案）复用。
 */
export async function setPendingVerification(
  db: D1Database,
  botId: number,
  userId: number,
  params: { answer: number; msgId: number },
): Promise<void> {
  await db
    .prepare(
      "UPDATE users SET verify_answer = ?, verify_msg_id = ? WHERE bot_id = ? AND user_id = ?",
    )
    .bind(params.answer, params.msgId, botId, userId)
    .run();
}

/**
 * 标记验证通过（T27）：`is_verified 0→1 + verified_at + 清空题目字段`，
 * WHERE 带 `is_verified = 0` 使「是否发生转换」可辨（幂等重放返回 false）。
 */
export async function markVerified(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users
       SET is_verified = 1, verified_at = ?, verify_answer = NULL, verify_msg_id = NULL
       WHERE bot_id = ? AND user_id = ? AND is_verified = 0`,
    )
    .bind(nowIso(), botId, userId)
    .run();
  return result.meta.changes === 1;
}

/**
 * 撤销验证态（T29 超限重验）：is_verified=0 + 清 verified_at 与题目字段。
 * 不动限频列——窗口重置由 countMessageInWindow 按时间自行判定。
 */
export async function markUnverified(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE users
       SET is_verified = 0, verified_at = NULL, verify_answer = NULL, verify_msg_id = NULL
       WHERE bot_id = ? AND user_id = ?`,
    )
    .bind(botId, userId)
    .run();
}

/**
 * 作废全部 pending 验证题（T32 /verifymode 切换）：一次性清空所有行的
 * 题目字段（WHERE verify_msg_id IS NOT NULL——无题行零变更，幂等）。
 *
 * 归属判定（verify_msg_id 单道检查）保持不变，被清空的旧题回调天然落
 * 「题目已失效」分支——「旧题回调不能误通过」的实现根基。题目字段与
 * 验证态（is_verified / verified_at）互不相干：已验证用户不受影响。
 */
export async function clearAllPendingVerifications(db: D1Database): Promise<void> {
  await db
    .prepare(
      "UPDATE users SET verify_answer = NULL, verify_msg_id = NULL WHERE verify_msg_id IS NOT NULL",
    )
    .run();
}

/** 封禁 / 解禁（T35）：/ban /unban 命令的唯一写入口 */
export async function setBanned(
  db: D1Database,
  botId: number,
  userId: number,
  banned: boolean,
): Promise<void> {
  await db
    .prepare("UPDATE users SET is_banned = ? WHERE bot_id = ? AND user_id = ?")
    .bind(banned ? 1 : 0, botId, userId)
    .run();
}

/**
 * 置用户 deleted 态（T38 /archive 的 DB 状态之一）：表示软归档，不删除 users 行，
 * 也不参与验证门判定；验证态由 markUnverified 单独清理。物理 /deluser 会删行。幂等 setter。
 */
export async function markUserDeleted(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<void> {
  await db
    .prepare("UPDATE users SET status = 'deleted' WHERE bot_id = ? AND user_id = ?")
    .bind(botId, userId)
    .run();
}

/**
 * 复位用户 active 态（T38 重开链路）：resolveTopic 重开 closed 行时的唯一
 * 复位点（与 reopenTopic 成对），ensureUser 永不触碰 status 列（契约不变）。
 */
export async function markUserActive(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<void> {
  await db
    .prepare("UPDATE users SET status = 'active' WHERE bot_id = ? AND user_id = ?")
    .bind(botId, userId)
    .run();
}

/**
 * 高危标记 / 取消（T37）：/risk /unrisk 命令的唯一写入口。
 *
 * 单语句同时写 is_risk 与 risk_notice_at = NULL：置 1 清窗口使该用户
 * **下一条消息重新提醒一次**（重新标记 → 提示窗口重置，PRD 语义）；
 * 置 0 一并清——行内不留悬空窗口（再 /risk 语义与首次标记完全一致）。
 */
export async function setRisk(
  db: D1Database,
  botId: number,
  userId: number,
  risk: boolean,
): Promise<void> {
  await db
    .prepare(
      "UPDATE users SET is_risk = ?, risk_notice_at = NULL WHERE bot_id = ? AND user_id = ?",
    )
    .bind(risk ? 1 : 0, botId, userId)
    .run();
}

/**
 * 限频固定窗口计数（T29）：窗口内第 1..N 条放行，第 N+1 条拦截。
 *
 * 两条原子语句实现（design.md §二.3）：
 * ① 窗口过期（或从未计数）→ 重置窗口起点、计数置 1，changes=1 即放行；
 * ② 窗口内 → `rate_count + 1 WHERE rate_count < limit`，changes=1 放行，
 *    changes=0 即第 N+1 条 → 超限。单语句原子性（D1 串行化）保证并发下
 *    第 N+1 条必被拦。
 *
 * 只统计通过验证门的消息：调用方（inbound 门 ③）保证仅已验证用户到达此处。
 */
export async function countMessageInWindow(
  db: D1Database,
  botId: number,
  userId: number,
  limit: number,
): Promise<boolean> {
  const reset = await db
    .prepare(
      `UPDATE users SET rate_window_start = ?, rate_count = 1
       WHERE bot_id = ? AND user_id = ?
         AND (rate_window_start IS NULL OR rate_window_start <= ?)`,
    )
    .bind(nowIso(), botId, userId, isoBefore(RATE_WINDOW_MS))
    .run();
  if (reset.meta.changes === 1) return true;

  const bump = await db
    .prepare(
      `UPDATE users SET rate_count = rate_count + 1
       WHERE bot_id = ? AND user_id = ? AND rate_count < ?`,
    )
    .bind(botId, userId, limit)
    .run();
  return bump.meta.changes === 1;
}
