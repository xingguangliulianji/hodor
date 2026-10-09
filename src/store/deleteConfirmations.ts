export interface DeleteConfirmation {
  user_id: number;
  thread_id: number;
  started_at: number;
  status: "pending" | "cancelled" | "confirmed";
  confirm_callback_id: string | null;
}

export async function saveDeleteConfirmation(
  db: D1Database,
  botId: number,
  promptMsgId: number,
  userId: number,
  threadId: number,
  startedAt: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO delete_confirmations (bot_id, prompt_msg_id, user_id, thread_id, started_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(botId, promptMsgId, userId, threadId, startedAt).run();
}

export async function getDeleteConfirmation(
  db: D1Database,
  botId: number,
  promptMsgId: number,
): Promise<DeleteConfirmation | null> {
  return db.prepare(
    `SELECT user_id, thread_id, started_at, status, confirm_callback_id
     FROM delete_confirmations WHERE bot_id = ? AND prompt_msg_id = ?`,
  ).bind(botId, promptMsgId).first<DeleteConfirmation>();
}

export async function cancelDeleteConfirmation(
  db: D1Database,
  botId: number,
  promptMsgId: number,
  userId: number,
  threadId: number,
  startedAt: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE delete_confirmations SET status = 'cancelled'
     WHERE bot_id = ? AND prompt_msg_id = ? AND user_id = ? AND thread_id = ?
       AND started_at = ? AND status = 'pending'`,
  ).bind(botId, promptMsgId, userId, threadId, startedAt).run();
  return result.meta.changes === 1;
}

export async function claimDeleteConfirmation(
  db: D1Database,
  botId: number,
  promptMsgId: number,
  userId: number,
  threadId: number,
  startedAt: number,
  callbackId: string,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE delete_confirmations SET status = 'confirmed', confirm_callback_id = ?
     WHERE bot_id = ? AND prompt_msg_id = ? AND user_id = ? AND thread_id = ?
       AND started_at = ? AND status = 'pending'
       AND EXISTS (
         SELECT 1 FROM topics
         WHERE topics.bot_id = delete_confirmations.bot_id
           AND topics.user_id = delete_confirmations.user_id
           AND topics.thread_id = delete_confirmations.thread_id
       )`,
  ).bind(callbackId, botId, promptMsgId, userId, threadId, startedAt).run();
  return result.meta.changes === 1;
}
