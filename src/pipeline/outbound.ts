/**
 * 出站管线（T21 + T22 / T25 / T26 + T34/T35 命令分流，design.md「出站管线」
 * canonical order）：
 *
 * 1. extractContent → 支持集之外静默完成（零副作用）
 * 2. from 校验 + 管理员判定（非管理员见 4a：命令回提示、其余静默——
 *    **不触发无绑定提示**）
 * 3. message_thread_id 校验（缺 → 静默完成）
 * 4. 命令分流（T34/T35，判定口径：`/` 开头文本）：
 *    4a. 非管理员命令 → 回「仅管理员可用」提示后完成（真机验收增量：
 *        原静默改为可见反馈）；非管理员**非命令**文本沿用静默
 *    4b. 管理员命令 → 命令管线（/help /ban /unban / 未知命令提示）→
 *        **一律 return，永不中继、永不写账本**
 * 5. findUserIdByThread：命中 open → 继续；未命中 / closed → T26 无绑定
 *    提示发回该 thread（permanent → warn；retryable → 抛交重推）→ 完成
 * 6. 中继：relayContent 到用户私聊（不带 thread；per-type send 按 file_id
 *    直传——不用 forward，forward 头会向用户泄漏客服群名）
 * 7. 账本：中继 ok → insertMessage(direction 'out',
 *    group_msg_id = 管理员原始 message_id（完整落库，供阶段 6 /purgemsg），
 *    private_msg_id = 私聊中继消息 ID)
 *
 * TelegramResult 消费（error-handling spec）：retryable → 抛（→ webhook 500
 * 重推）；permanent（如 403 bot 被用户拉黑 / 400 毒丸）→ warn + 按已处理
 * 跳过且**不写账本**（T25 只记成功中继）；系统提示不入账本。
 */
import { NOT_ADMIN_COMMAND_NOTICE, UNBOUND_TOPIC_NOTICE } from "../copy";
import { parseAdminIds } from "../env";
import { insertMessage } from "../store/messages";
import { findUserIdByThread } from "../store/topics";
import { createTelegramClient } from "../telegram/client";
import { handleCommand } from "./commands";
import { extractContent, relayContent } from "./content";
import type { TelegramMessageRef } from "./classify";

/** 处理一条客服群 topic 内的 message。完成 = 按成功处理；抛出 = retryable 重推。 */
export async function handleOutbound(
  env: Cloudflare.Env,
  botId: number,
  message: TelegramMessageRef,
): Promise<void> {
  // 1. 支持集之外 / 畸形内容 → 静默完成（零副作用，不触发提示）
  const payload = extractContent(message);
  if (payload === null) return;
  // 2. from 校验（缺 id 视同畸形信封，静默完成）+ 管理员判定
  const from = message.from;
  if (!from || typeof from.id !== "number") return;
  const isAdmin = parseAdminIds(env).includes(from.id);

  // classify 已保证 outbound 带 message_thread_id；缺线程号视同畸形，静默完成
  //（提示 / 命令回复 / 中继都以 thread 定位，统一在此校验）
  const threadId = message.message_thread_id;
  if (typeof threadId !== "number") return;

  // 命令判定（与命令管线同一口径）：`/` 开头的文本消息（extractContent
  // 保证 text 类型正文非空）
  const commandText = payload.type === "text" ? payload.text : undefined;
  const isCommand = commandText !== undefined && commandText.startsWith("/");

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);

  // 4a. 非管理员：命令 → 回提示后完成（验收增量：静默改为可见反馈）；
  // 其余（含媒体 / 普通文本）沿用阶段 3 静默。三态消费与 T26 提示一致：
  // permanent → warn 吞；retryable → 抛交重推。
  // 无节流面（权衡）：发送者是群成员而非 bot 用户——没有 users 行 /
  // claimNoticeSlot 可用，且群为私有可信环境、提示只落该 topic；如后续
  // 需要再加节流（T30 频控只覆盖 bot → 用户的私聊提示）。
  if (!isAdmin) {
    if (isCommand) {
      const notice = await client.sendMessage({
        chat_id: message.chat.id,
        text: NOT_ADMIN_COMMAND_NOTICE,
        message_thread_id: threadId,
      });
      if (!notice.ok) {
        if (notice.kind === "retryable") {
          throw new Error(notice.errorMessage ?? "sendMessage retryable");
        }
        console.warn(
          `[outbound] thread ${threadId}: 非管理员命令提示 permanent，跳过：${notice.errorMessage ?? "no detail"}`,
        );
      }
    }
    return;
  }

  // 4b. 管理员命令 → 命令管线终结本条（永不中继、永不写账本）
  if (isCommand && commandText !== undefined) {
    await handleCommand(env, botId, { chatId: message.chat.id, threadId, text: commandText });
    return;
  }

  /* ---------------- 5. 反查绑定（closed 对出站视同未绑定） ---------------- */
  const owner = await findUserIdByThread(env.HODOR_DB, botId, threadId);
  if (!owner || owner.status !== "open") {
    // T26 无绑定提示：发回管理员发言的同一 topic（classify 保证 message.chat
    // 即客服群，chat.id 运行时已校验为数字）——绝不发往任何用户私聊
    const notice = await client.sendMessage({
      chat_id: message.chat.id,
      text: UNBOUND_TOPIC_NOTICE,
      message_thread_id: threadId,
    });
    if (!notice.ok) {
      if (notice.kind === "retryable") {
        throw new Error(notice.errorMessage ?? "sendMessage retryable");
      }
      console.warn(
        `[outbound] thread ${threadId}: 无绑定提示 permanent，跳过：${notice.errorMessage ?? "no detail"}`,
      );
    }
    return;
  }

  /* ---------------- 6. 中继（私聊不带 thread） ---------------- */
  const relayed = await relayContent(client, payload, { chatId: owner.user_id });
  if (!relayed.ok) {
    if (relayed.kind === "retryable") {
      throw new Error(relayed.errorMessage ?? "relay retryable");
    }
    // permanent：重试无益，消息被丢弃——不写账本
    console.warn(
      `[outbound] thread ${threadId} → user ${owner.user_id}: 中继 permanent，按已处理跳过（消息被丢弃，不写账本）：${relayed.errorMessage ?? "no detail"}`,
    );
    return;
  }

  /* ---------------- 7. 账本（T25 out 行双 ID；失败原样抛 → 重推） ---------------- */
  await insertMessage(env.HODOR_DB, {
    botId,
    userId: owner.user_id,
    threadId,
    direction: "out",
    groupMsgId: message.message_id,
    privateMsgId: relayed.result.message_id,
    contentType: payload.type,
  });
}
