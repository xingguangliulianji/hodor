import type { TelegramMessageRef } from "./classify";
import { setTopicStateByThread } from "../store/topics";

/** Native forum-topic service updates only project Telegram's topic state. */
export async function handleTopicEvent(
  db: D1Database,
  botId: number,
  message: TelegramMessageRef,
): Promise<void> {
  const threadId = message.message_thread_id;
  const closed = message.forum_topic_closed;
  const reopened = message.forum_topic_reopened;
  if (!Number.isSafeInteger(threadId) || (threadId as number) <= 0) return;
  if ((closed === undefined) === (reopened === undefined)) return;
  if (closed !== undefined && (typeof closed !== "object" || closed === null || Array.isArray(closed))) return;
  if (reopened !== undefined && (typeof reopened !== "object" || reopened === null || Array.isArray(reopened))) return;

  const changed = await setTopicStateByThread(db, botId, threadId as number, closed !== undefined);
  if (!changed) console.warn(`[topic-event] no topic binding for thread ${threadId}; ignored`);
}
