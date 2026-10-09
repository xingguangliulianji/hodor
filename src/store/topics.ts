/**
 * topics 表 store：用户 ↔ topic 双向映射（docs/guide/database.md）。
 *
 * - 入站正向查：findTopicByUser（PK bot_id,user_id）
 * - 出站反查：findUserIdByThread（UNIQUE bot_id,thread_id）；closed 行对出站
 *   视同未绑定（静默忽略）
 * - 复用语义：closed 行不删，reopenTopic 重开（「一个人终身一个 topic」）
 * - 竞态兜底：insertTopic 原样抛出唯一冲突（UNIQUE），由 pipeline 的败方
 *   清理流程接手——store 只管数据，不做补偿
 */
import { nowIso } from "./util";

/** 正向查找返回的行子集（status 供调用方区分 open / closed；pinned_msg_id 供置顶流程判定） */
export interface TopicRow {
  thread_id: number;
  title: string;
  status: string;
  /** 置顶的用户信息消息 ID；null = 尚未置顶（或上次置顶未落库）——置顶流程的唯一入口判定 */
  pinned_msg_id: number | null;
  /**
   * 管理员备注（topics.note，T36）：置顶信息「备注」行的数据源；随 topic
   * 终身保留（存 topics 行而非 users——/archive 或原生 close 后重开仍在）
   */
  note: string | null;
}

/** 按 (bot_id, user_id) 查映射行；无行 → null */
export async function findTopicByUser(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<TopicRow | null> {
  return db
    .prepare(
      "SELECT thread_id, title, status, pinned_msg_id, note FROM topics WHERE bot_id = ? AND user_id = ?",
    )
    .bind(botId, userId)
    .first<TopicRow>();
}

/**
 * 写 / 清管理员备注（T36）：/note /unnote 命令的唯一写入口。
 * note = null 即清空（/unnote）；UPDATE 0 行（无绑定）由调用方以
 * findUserIdByThread 先行反查保证——setter 不做存在性判断（与 setBanned
 * 同姿态）。备注为纯治理信息，永不影响中继 / 账本。
 */
export async function setTopicNote(
  db: D1Database,
  botId: number,
  userId: number,
  note: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE topics SET note = ? WHERE bot_id = ? AND user_id = ?")
    .bind(note, botId, userId)
    .run();
}

/**
 * 记录置顶的用户信息消息 ID（T24）：置顶消息发出（无论 pin 调用本身是否
 * 成功——信息消息已在，供后续昵称变更 edit 刷新）后落库。
 * 「每 topic 恰一条置顶」由此列驱动：非 null 即不再重发。
 */
export async function setPinnedMsgId(
  db: D1Database,
  botId: number,
  userId: number,
  pinnedMsgId: number,
): Promise<void> {
  await db
    .prepare("UPDATE topics SET pinned_msg_id = ? WHERE bot_id = ? AND user_id = ?")
    .bind(pinnedMsgId, botId, userId)
    .run();
}

/** 重开 closed 行（原生 close / archive 后用户再来即重开；closed_at 清空） */
export async function setTopicStateByThread(
  db: D1Database,
  botId: number,
  threadId: number,
  closed: boolean,
): Promise<boolean> {
  const result = await db
    .prepare(
      closed
        ? "UPDATE topics SET status = 'closed', closed_at = COALESCE(closed_at, ?) WHERE bot_id = ? AND thread_id = ?"
        : "UPDATE topics SET status = 'open', closed_at = NULL WHERE bot_id = ? AND thread_id = ?",
    )
    .bind(...(closed ? [nowIso(), botId, threadId] : [botId, threadId]))
    .run();
  return result.meta.changes === 1;
}

export async function reopenTopic(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE topics SET status = 'open', closed_at = NULL WHERE bot_id = ? AND user_id = ?",
    )
    .bind(botId, userId)
    .run();
}

/**
 * 关闭映射行（T38 /archive 的 DB 真值先行步骤之一）：status='closed' +
 * closed_at。幂等 setter——重推 / 重复执行同值无害；行删除与否由 closeForumTopic
 * 结果决定，本函数不做存在性判断（与 setBanned 同姿态，调用方先反查绑定）。
 */
export async function closeTopic(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE topics SET status = 'closed', closed_at = ? WHERE bot_id = ? AND user_id = ?",
    )
    .bind(nowIso(), botId, userId)
    .run();
}

/**
 * 删除绑定行（阶段 6 自愈路径，design §五.2）：topic 被原生删除后绑定指向
 * 已不存在的 thread——删行让下一条消息（或本条的重开路径）走新建 topic。
 * 唯一调用点带 topic-gone 判定（isTopicGoneError），可恢复的配置问题绝不
 * 误删。note 随行丢失、messages 历史行保留（thread_id 悬空无害）——PRD 已
 * 接受代价。
 */
export async function deleteTopicBinding(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<void> {
  await db
    .prepare("DELETE FROM topics WHERE bot_id = ? AND user_id = ?")
    .bind(botId, userId)
    .run();
}

/**
 * 清空置顶消息 ID（T39 /purgemsg 重置置顶第一步）：旧信息卡已删，
 * pinned_msg_id 置 NULL 使重发流程（pinUserCard）成为唯一置顶入口，
 * 「每 topic 恰一条置顶」的列驱动语义不变。
 */
export async function clearPinnedMsgId(
  db: D1Database,
  botId: number,
  userId: number,
): Promise<void> {
  await db
    .prepare("UPDATE topics SET pinned_msg_id = NULL WHERE bot_id = ? AND user_id = ?")
    .bind(botId, userId)
    .run();
}

/** 新映射行参数（title 建档时定死，不再复算） */
export interface NewTopicRow {
  botId: number;
  userId: number;
  threadId: number;
  title: string;
}

/**
 * 写入新映射行：唯一冲突（(bot_id,user_id) 或 (bot_id,thread_id)）时
 * 原样抛出 D1 错误，由调用方执行竞态败方清理。
 */
export async function insertTopic(db: D1Database, row: NewTopicRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO topics (bot_id, user_id, thread_id, title, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(row.botId, row.userId, row.threadId, row.title, nowIso())
    .run();
}

/** 出站反查返回：目标用户与其行状态（closed 对出站视同未绑定） */
export interface ThreadOwnerRow {
  user_id: number;
  status: string;
}

/** 按 (bot_id, thread_id) 反查目标用户；无行 → null（含 closed 行也返回，由调用方判定） */
export async function findUserIdByThread(
  db: D1Database,
  botId: number,
  threadId: number,
): Promise<ThreadOwnerRow | null> {
  return db
    .prepare("SELECT user_id, status FROM topics WHERE bot_id = ? AND thread_id = ?")
    .bind(botId, threadId)
    .first<ThreadOwnerRow>();
}

/** D1 唯一冲突错误判定（消息含 "UNIQUE constraint failed"），竞态清理的唯一信号 */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}
