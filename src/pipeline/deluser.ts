import {
  DELUSER_CANCEL_LABEL, DELUSER_CONFIRM_LABEL, DELUSER_TOAST_CANCELLED,
  DELUSER_TOAST_DONE, DELUSER_TOAST_EXPIRED, DELUSER_TOAST_FAILED,
  DELUSER_TOAST_NOT_ADMIN,
} from "../copy";
import { parseAdminIds, parseSupportChatId } from "../env";
import {
  cancelDeleteConfirmation,
  claimDeleteConfirmation,
  getDeleteConfirmation,
} from "../store/deleteConfirmations";
import { findTopicByUser, findUserIdByThread } from "../store/topics";
import { deleteUserData } from "../store/wipe";
import { createTelegramClient } from "../telegram/client";
import type { InlineKeyboardMarkup, TelegramClient } from "../telegram/types";
import type { TelegramCallbackQueryRef } from "./classify";
import { isTopicGoneError } from "./errors";

export const DELUSER_CALLBACK_TIMEOUT_SECONDS = 60;

export function buildDeluserKeyboard(userId: number, threadId: number, epoch: number): InlineKeyboardMarkup {
  return { inline_keyboard: [[
    { text: DELUSER_CONFIRM_LABEL, callback_data: `d:yes:${userId}:${threadId}:${epoch}` },
    { text: DELUSER_CANCEL_LABEL, callback_data: `d:no:${userId}:${threadId}:${epoch}` },
  ]] };
}

function parseData(data: string): { confirm: boolean; userId: number; threadId: number; epoch: number } | null {
  const match = data.match(/^d:(yes|no):(\d{1,16}):(\d{1,16}):(\d{1,12})$/);
  if (!match) return null;
  const [, action, user, thread, epoch] = match;
  const userId = Number(user), threadId = Number(thread), startedAt = Number(epoch);
  if (![userId, threadId, startedAt].every(Number.isSafeInteger) || userId <= 0 || threadId <= 0) return null;
  return { confirm: action === "yes", userId, threadId, epoch: startedAt };
}

async function answer(client: TelegramClient, callbackId: string, text: string): Promise<void> {
  const result = await client.answerCallbackQuery({ callbackQueryId: callbackId, text });
  if (!result.ok && result.kind === "retryable") throw new Error(result.errorMessage ?? "answerCallbackQuery retryable");
  if (!result.ok) console.warn(`[deluser] callback answer permanent: ${result.errorMessage ?? "no detail"}`);
}

/**
 * 把确认提示消息改写为终态结果并移除键盘。toast（answerCallbackQuery）
 * 在客户端上短暂且可能被吞；消息改写让取消 / 超时结果在话题里可见。
 * retryable 抛交重推；permanent（含重复 edit 的 "message is not modified"）warn 吞。
 */
async function finalizePrompt(
  client: TelegramClient,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  const edited = await client.editMessageText({ chat_id: chatId, message_id: messageId, text });
  if (!edited.ok) {
    if (edited.kind === "retryable") throw new Error(edited.errorMessage ?? "editMessageText retryable");
    console.warn(`[deluser] 确认提示编辑失败：${edited.errorMessage ?? "no detail"}`);
  }
}

export async function handleDeluserCallback(
  env: Cloudflare.Env,
  botId: number,
  callback: TelegramCallbackQueryRef,
): Promise<void> {
  const parsed = typeof callback.data === "string" ? parseData(callback.data) : null;
  const message = callback.message;
  // Telegram 的 callback_query.message 不保证携带 message_thread_id。若提供则
  // 必须匹配按钮目标；若缺失，使用警告消息 ID 与 D1 当前双向绑定共同校验。
  if (
    !parsed || !message ||
    message.chat.id !== parseSupportChatId(env) ||
    message.chat.type !== "supergroup" ||
    (message.message_thread_id !== undefined && message.message_thread_id !== parsed.threadId)
  ) return;

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  if (!parseAdminIds(env).includes(callback.from.id)) {
    await answer(client, callback.id, DELUSER_TOAST_NOT_ADMIN);
    return;
  }

  const confirmation = await getDeleteConfirmation(env.HODOR_DB, botId, message.message_id);
  if (
    !confirmation || confirmation.user_id !== parsed.userId ||
    confirmation.thread_id !== parsed.threadId || confirmation.started_at !== parsed.epoch
  ) {
    await answer(client, callback.id, DELUSER_TOAST_FAILED);
    return;
  }

  const ageSeconds = Date.now() / 1000 - parsed.epoch;
  const expired = ageSeconds > DELUSER_CALLBACK_TIMEOUT_SECONDS || ageSeconds < -5;
  if (!parsed.confirm) {
    if (confirmation.status === "confirmed") {
      await answer(client, callback.id, DELUSER_TOAST_FAILED);
      return;
    }
    if (confirmation.status === "pending" && expired) {
      await answer(client, callback.id, DELUSER_TOAST_EXPIRED);
      await finalizePrompt(client, message.chat.id, message.message_id, DELUSER_TOAST_EXPIRED);
      return;
    }
    if (confirmation.status === "pending") {
      const cancelled = await cancelDeleteConfirmation(
        env.HODOR_DB, botId, message.message_id,
        parsed.userId, parsed.threadId, parsed.epoch,
      );
      if (!cancelled) {
        await answer(client, callback.id, DELUSER_TOAST_FAILED);
        return;
      }
    }
    await answer(client, callback.id, DELUSER_TOAST_CANCELLED);
    await finalizePrompt(client, message.chat.id, message.message_id, DELUSER_TOAST_CANCELLED);
    return;
  }

  if (confirmation.status === "cancelled") {
    await answer(client, callback.id, DELUSER_TOAST_FAILED);
    return;
  }
  if (confirmation.status === "confirmed" && confirmation.confirm_callback_id !== callback.id) {
    await answer(client, callback.id, DELUSER_TOAST_FAILED);
    return;
  }
  if (confirmation.status === "pending" && expired) {
    await answer(client, callback.id, DELUSER_TOAST_EXPIRED);
    await finalizePrompt(client, message.chat.id, message.message_id, DELUSER_TOAST_EXPIRED);
    return;
  }

  const owner = await findUserIdByThread(env.HODOR_DB, botId, parsed.threadId);
  const topic = await findTopicByUser(env.HODOR_DB, botId, parsed.userId);
  if (!owner || owner.user_id !== parsed.userId || topic?.thread_id !== parsed.threadId) {
    await answer(client, callback.id, DELUSER_TOAST_FAILED);
    return;
  }
  if (confirmation.status === "pending") {
    const claimed = await claimDeleteConfirmation(
      env.HODOR_DB, botId, message.message_id,
      parsed.userId, parsed.threadId, parsed.epoch, callback.id,
    );
    if (!claimed) {
      // 并发确认/取消只允许原子 UPDATE 赢的一方执行；同一 callback id
      // 在 claim 后失败的 webhook 重推可以继续已授权的删除。
      const current = await getDeleteConfirmation(env.HODOR_DB, botId, message.message_id);
      if (current?.status !== "confirmed" || current.confirm_callback_id !== callback.id) {
        await answer(client, callback.id, DELUSER_TOAST_FAILED);
        return;
      }
    }
  }

  const deleted = await client.deleteForumTopic({ chat_id: message.chat.id, message_thread_id: parsed.threadId });
  if (!deleted.ok) {
    if (deleted.kind === "retryable") throw new Error(deleted.errorMessage ?? "deleteForumTopic retryable");
    if (!isTopicGoneError(deleted.errorMessage)) {
      await answer(client, callback.id, DELUSER_TOAST_FAILED);
      return;
    }
  }

  // D1 batch 原子删除：若 TG 删除成功而 D1 失败，同一 callback id 的 webhook
  // 重推仍可继续（确认意图已在 60 秒窗口内持久化），其他回调不得复用授权。
  // 双方私聊窗口历史始终不在删除范围内。
  await deleteUserData(env.HODOR_DB, botId, parsed.userId, parsed.threadId);
  await answer(client, callback.id, DELUSER_TOAST_DONE);
}
