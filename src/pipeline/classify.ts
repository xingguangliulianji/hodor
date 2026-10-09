/**
 * update 分流（T15/T27 callback + T38 deluser callback + 原生 topic service event + T40 群回调）：纯函数，无 IO。
 *
 * 输入是 webhook 解析出的 JSON（不可信），所以一切字段先做运行时形态校验，
 * 任何不完整 / 非预期形态一律 'ignore'（安全忽略，零副作用）。
 *
 * 规则（design.md「出站管线/入站管线」）：
 * - callback_query 存在 → 回调形态（id / from.id / message.message_id /
 *   message.chat.id 数值全合法）后按 chat 归属：
 *   chat.type === 'private' → callback（私聊题面按钮，T27）；
 *   chat.id === SUPPORT_CHAT_ID → group_callback（客服群内按钮，T38/T40 确认）；
 *   其他群 / 畸形 → ignore
 * - 客服群 message 带 forum_topic_closed / forum_topic_reopened + 合法 thread → topic_event
 * - 无 message 且无 callback_query（edited_message / channel_post 等）→ ignore
 * - chat.type === 'private' → inbound（用户私聊）
 * - chat.id === SUPPORT_CHAT_ID 且带 message_thread_id → outbound（topic 内发言）
 * - chat.id === SUPPORT_CHAT_ID 且无 thread（General / 非 topic）→ ignore
 * - 其他 chat → ignore
 */

export type UpdateClassification =
  | "inbound"
  | "outbound"
  | "callback"
  | "group_callback"
  | "topic_event"
  | "ignore";

/** update.message.from 的最小子集（入站建档 / 出站管理员判定用） */
export interface TelegramFromRef {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/** update.message 的最小子集（本阶段所需字段） */
export interface TelegramMessageRef {
  message_id: number;
  from?: TelegramFromRef;
  chat: { id: number; type: string };
  text?: string;
  message_thread_id?: number;
  /**
   * 媒体载荷（T22 / 阶段 3）：webhook 输入不可信，形态一律不在本文件校验——
   * 分流只看 chat / thread（媒体不改变路由），字段形态由
   * pipeline/content.ts 的 extractContent 逐字段运行时校验
   */
  photo?: unknown;
  video?: unknown;
  voice?: unknown;
  /** 音频（音乐文件）：2026-09-30 真机验收按用户要求纳入支持集 */
  audio?: unknown;
  document?: unknown;
  sticker?: unknown;
  animation?: unknown;
  /** 媒体 caption（与 photo/video/voice/audio/document/animation 搭配，sticker 不可能携带） */
  caption?: unknown;
  forum_topic_closed?: unknown;
  forum_topic_reopened?: unknown;
}

/** Telegram update 信封的最小子集（无关字段忽略） */
export interface TelegramUpdateRef {
  update_id: number;
  message?: TelegramMessageRef;
  /** 私聊题面按钮回调（T27 验证答题）；分流形态校验见 classifyUpdate */
  callback_query?: TelegramCallbackQueryRef;
}

/**
 * callback_query 的最小子集（T27 + T40）：
 * id 供 answerCallbackQuery；message 供归属判定（verify_msg_id 对比 / wipe
 * 原消息编辑定位）；data 为按钮载荷——私聊验证题为 "v:<值>"（绝不含答案
 * 以外的信息），客服群 wipe 确认为 "w:yes|no:<发起时间戳>"。
 */
export interface TelegramCallbackQueryRef {
  id: string;
  from: TelegramFromRef;
  /** 题面消息引用（可选：极老客户端可能不带 → classify 判 ignore） */
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    message_thread_id?: number;
  };
  data?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 分流一条 update。
 *
 * @param update webhook 解析出的 JSON（unknown：字段运行时校验）
 * @param supportChatId 客服超级群 chat_id（parseSupportChatId 结果）
 *
 * supportChatId === null（env 畸形）→ **一切返回 'ignore'（fail-closed）**：
 * 部署配置坏了，任何分流都可能把消息转错群；宁可零副作用地吞掉
 * （webhook 层照常 markProcessed + 200），配置问题由部署侧日志暴露，
 * 绝不能让错误配置产生半吊子副作用后靠 500 重推去放大。
 */
export function classifyUpdate(
  update: unknown,
  supportChatId: number | null,
): UpdateClassification {
  if (supportChatId === null) return "ignore";

  if (!isRecord(update)) return "ignore";

  // callback_query 分流（T27 私聊 / T40 客服群）：先于 message 判定——两者
  // 理论上互斥，但畸形信封同时携带时优先按回调形态裁决（不回落到中继路径）
  const callbackQuery = update.callback_query;
  if (isRecord(callbackQuery)) {
    // id 供 answerCallbackQuery 单次消费：非字符串（缺失 / 数字等）→ ignore。
    // 不校验会把畸形 id 送到 Telegram 吃 400 permanent——虽 fail-safe，
    // 但形态防护应在分流层收口（与其他字段一致，trellis-check P2#1）
    if (typeof callbackQuery.id !== "string") return "ignore";
    const cbFrom = callbackQuery.from;
    if (!isRecord(cbFrom) || typeof cbFrom.id !== "number") return "ignore";
    const cbMessage = callbackQuery.message;
    if (!isRecord(cbMessage) || typeof cbMessage.message_id !== "number") return "ignore";
    const cbChat = cbMessage.chat;
    if (!isRecord(cbChat) || typeof cbChat.id !== "number" || typeof cbChat.type !== "string") {
      return "ignore";
    }
    // 按按钮所在 chat 归属：私聊 → 验证答题；客服群 → wipe 确认（T40）；
    // 其余群（bot 被拉进别的群等）一律 ignore
    if (cbChat.type === "private") return "callback";
    if (cbChat.id === supportChatId) return "group_callback";
    return "ignore";
  }

  const message = update.message;
  // edited_message 等都不走 .message —— 统一 ignore
  if (!isRecord(message)) return "ignore";
  const chat = message.chat;
  if (!isRecord(chat) || typeof chat.id !== "number" || typeof chat.type !== "string") {
    return "ignore";
  }

  if (chat.type === "private") return "inbound";

  if (chat.id === supportChatId) {
    const validThread = Number.isSafeInteger(message.message_thread_id) && (message.message_thread_id as number) > 0;
    const validMessageId = Number.isSafeInteger(message.message_id) && (message.message_id as number) > 0;
    const hasClosedEvent = isRecord(message.forum_topic_closed);
    const hasReopenedEvent = isRecord(message.forum_topic_reopened);
    const hasTopicEvent = "forum_topic_closed" in message || "forum_topic_reopened" in message;
    if (hasTopicEvent) {
      return validMessageId && validThread && hasClosedEvent !== hasReopenedEvent ? "topic_event" : "ignore";
    }
    return validThread ? "outbound" : "ignore";
  }
  return "ignore";
}
