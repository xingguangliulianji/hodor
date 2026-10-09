/**
 * 管理命令管线（T34/T35/T36/T37/T31/T32 + T38/T39/T40）：
 * outbound 在管理员校验后把 `/` 开头文本整条移交本管线——命令永不中继、永不
 * 写 messages 账本。非管理员命令的提示由 outbound 管线处理。
 *
 * - `/archive`：soft lifecycle 操作，关闭 TG topic、清验证并保留 users/topics/messages/note；
 *   close 后结果发到客服群 General，绝不依赖向 closed topic 发送。
 * - `/deluser`：只发物理删除警告键盘；真正执行在 pipeline/deluser.ts callback，
 *   先删 TG topic，再批量清对应 users/topics/messages；结果用 callback toast。
 * - `/purgemsg`：绑定 scope，账本 + pinned 驱动的群内消息清理。
 * - `/wipealldata`：全局 scope，两步确认后先删全部群内话题再清数据库（执行在 pipeline/wipe.ts）。
 * - 其余命令维持既有分流与三态失败语义；所有系统消息零 messages 账本。
 */
import {
  ARCHIVE_CLOSE_FAILED_TEXT,
  ARCHIVE_PREPARING_TEXT,
  ARCHIVE_SUCCESS_TEXT,
  ARCHIVE_USER_NOTICE,
  DELUSER_WARNING_TEXT,
  formatBanConfirmed,
  formatHelpText,
  formatNoteConfirmed,
  formatPurgeConfirmed,
  formatRiskConfirmed,
  formatUnbanConfirmed,
  formatUnnoteConfirmed,
  formatUnriskConfirmed,
  formatVerifyModeConfirmed,
  formatVerifyOffConfirmed,
  formatVerifyOnConfirmed,
  NOTE_USAGE_NOTICE,
  UNBOUND_TOPIC_NOTICE,
  UNKNOWN_COMMAND_NOTICE,
  WIPE_WARNING_TEXT,
} from "../copy";
import {
  composePinnedText,
  downgradePinnedToUnverified,
  editPinnedBestEffort,
  pinUserCard,
} from "./pinned";
import { buildWipeKeyboard } from "./wipe";
import { buildDeluserKeyboard } from "./deluser";
import { isMessageGoneError, isTopicGoneError, isTopicNotModifiedError } from "./errors";
import {
  clearPinnedMsgId,
  closeTopic,
  findTopicByUser,
  findUserIdByThread,
  setTopicNote,
} from "../store/topics";
import {
  deleteThreadMessages,
  listThreadGroupMsgIds,
} from "../store/messages";
import {
  clearAllPendingVerifications,
  markUnverified,
  markUserDeleted,
  setBanned,
  setRisk,
} from "../store/users";
import {
  getVerificationSettings,
  setVerificationEnabled,
  setVerificationMode,
} from "../store/settings";
import { createTelegramClient } from "../telegram/client";
import { saveDeleteConfirmation } from "../store/deleteConfirmations";
import type { InlineKeyboardMarkup } from "../telegram/types";

/**
 * 备注最大长度（Unicode 码点数）：落库前截断——置顶信息 = 昵称 / ID /
 * 时间等固定行 + 备注行，Telegram 消息上限 4096 字符；500 码点（emoji
 * 等增补平面字符按 1 计）给备注行留出充裕空间的同时保证 editMessageText
 * 绝不超限。按码点（而非 UTF-16 code unit）截断，避免把 emoji 从中间
 * 切成乱码。
 */
const NOTE_MAX_CODEPOINTS = 500;

/**
 * 解析命令名：首 token 去 `@botname` 后缀（`/ban@hodor_bot 附加参数` →
 * `/ban`）。命令只看首 token；是否为命令（`/` 前缀）由调用方 outbound
 * 先行判定。
 */
export function parseCommandName(text: string): string {
  const firstToken = text.split(/\s+/)[0] ?? "";
  const at = firstToken.indexOf("@");
  return at === -1 ? firstToken : firstToken.slice(0, at);
}

/**
 * 解析命令参数（/note 消费）：首 token（命令名，可带 @bot 后缀）之后的
 * 剩余文本，trim 两端。内部空白原样保留（备注内容不该被压缩重排）；
 * `/note` / `/note   ` → ""（空参数，调用方回用法提示）。
 */
export function parseCommandArgs(text: string): string {
  return text.replace(/^\S+\s*/, "").trim();
}

/** topic 内命令回复的三态消费：retryable → 抛（重推）；permanent → warn 吞 */
async function replyInTopic(
  env: Cloudflare.Env,
  chatId: number,
  threadId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const sent = await client.sendMessage({
    chat_id: chatId,
    text,
    message_thread_id: threadId,
    ...(replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
  });
  if (!sent.ok) {
    if (sent.kind === "retryable") {
      throw new Error(sent.errorMessage ?? "sendMessage retryable");
    }
    console.warn(
      `[commands] thread ${threadId}: 命令回复 permanent，跳过：${sent.errorMessage ?? "no detail"}`,
    );
  }
}

/**
 * 话题已关闭后不能依赖向原 thread 发消息；归档结果改发客服群 General。
 * 这是系统反馈，不进入对话账本。retryable 抛出后命令重推以幂等状态收敛。
 */
async function replyInGeneral(
  env: Cloudflare.Env,
  chatId: number,
  text: string,
): Promise<void> {
  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const sent = await client.sendMessage({ chat_id: chatId, text });
  if (!sent.ok) {
    if (sent.kind === "retryable") throw new Error(sent.errorMessage ?? "sendMessage retryable");
    console.warn(`[commands] General 命令反馈 permanent，跳过：${sent.errorMessage ?? "no detail"}`);
  }
}

/**
 * 处理一条管理员命令（outbound 管理员校验 + thread 校验后移交）。
 * 完成（resolve）= 按成功处理；抛出（reject）= retryable，交 webhook 500 重推。
 * 无论命中哪条分支，本函数返回后该 update 即告终结——outbound 不再走
 * 绑定查找 / 中继 / 账本（「/ 开头永不中继」的唯一保证点）。
 */
export async function handleCommand(
  env: Cloudflare.Env,
  botId: number,
  params: { chatId: number; threadId: number; text: string },
): Promise<void> {
  const { chatId, threadId } = params;
  const name = parseCommandName(params.text);

  if (name === "/help") {
    // /help 不依赖绑定：无论哪个 topic 都能看（含无绑定 / closed topic）。
    // 帮助接库内 settings 真值（T32 动态化）：验证段随开关 / 模式变化——
    // 开 → 只展示 /verifyoff，关 → /verifyon + 「当前验证已关闭」标注
    await replyInTopic(
      env,
      chatId,
      threadId,
      formatHelpText(await getVerificationSettings(env.HODOR_DB)),
    );
    return;
  }

  if (name === "/ban" || name === "/unban") {
    // 反查绑定：closed 行同样可操作（管理操作不依赖 open——区别于中继的
    // 「closed 视同未绑定」）；无行 → 复用 T26 提示（绝不猜测目标用户）
    const owner = await findUserIdByThread(env.HODOR_DB, botId, threadId);
    if (!owner) {
      await replyInTopic(env, chatId, threadId, UNBOUND_TOPIC_NOTICE);
      return;
    }
    // DB 真值先行（幂等 setter）：确认回复 retryable → 抛 → 重推只会
    // 重发回复并重复执行同一赋值，不产生状态振荡或用户侧副作用
    await setBanned(env.HODOR_DB, botId, owner.user_id, name === "/ban");
    await replyInTopic(
      env,
      chatId,
      threadId,
      name === "/ban"
        ? formatBanConfirmed(owner.user_id)
        : formatUnbanConfirmed(owner.user_id),
    );
    return;
  }

  /* ------------- T36/T37 备注与高危组（需绑定，/ban 同姿态） ------------- */
  if (name === "/note" || name === "/unnote" || name === "/risk" || name === "/unrisk") {
    // /note 空参数：用法提示先于绑定判定（M2 契约——本命令的核心防御是
    // 「绝不误写空备注」，误触 /note 不该落到任何绑定语义）
    const args = parseCommandArgs(params.text);
    if (name === "/note" && args === "") {
      await replyInTopic(env, chatId, threadId, NOTE_USAGE_NOTICE);
      return;
    }
    // 反查绑定：closed 行同样可操作（治理操作不依赖 open）；无行 → T26 提示
    const owner = await findUserIdByThread(env.HODOR_DB, botId, threadId);
    if (!owner) {
      await replyInTopic(env, chatId, threadId, UNBOUND_TOPIC_NOTICE);
      return;
    }
    const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
    if (name === "/note") {
      // 长度防御：按码点截断（NOTE_MAX_CODEPOINTS 详见常量注释）——确认
      // 回显截断后的值（= 实际落库值，copy 契约「回显写入的备注」）
      const note = [...args].slice(0, NOTE_MAX_CODEPOINTS).join("");
      // DB 真值先行（幂等 setter）：确认 / 置顶刷新失败重推只会重发回复
      // 并重复执行同一赋值，不产生状态振荡或用户侧副作用
      await setTopicNote(env.HODOR_DB, botId, owner.user_id, note);
      await editPinnedBestEffort(env, client, botId, owner.user_id);
      await replyInTopic(env, chatId, threadId, formatNoteConfirmed(note));
      return;
    }
    if (name === "/unnote") {
      await setTopicNote(env.HODOR_DB, botId, owner.user_id, null);
      await editPinnedBestEffort(env, client, botId, owner.user_id);
      await replyInTopic(env, chatId, threadId, formatUnnoteConfirmed());
      return;
    }
    // /risk / /unrisk：setRisk 单语句同时清 risk_notice_at（重新标记 →
    // 24h 提醒窗口重置；取消 → 行内不留悬空窗口）
    const risk = name === "/risk";
    await setRisk(env.HODOR_DB, botId, owner.user_id, risk);
    await editPinnedBestEffort(env, client, botId, owner.user_id);
    await replyInTopic(
      env,
      chatId,
      threadId,
      risk ? formatRiskConfirmed(owner.user_id) : formatUnriskConfirmed(owner.user_id),
    );
    return;
  }

  /* ------------- T31/T32 验证配置组（全局命令，/help 同姿态无需绑定） ------------- */
  if (name === "/verifyon" || name === "/verifyoff") {
    // 幂等 setter（DB 真值先行）：重复执行同值无害——确认回复失败重推只会
    // 重发回复并重复执行同一赋值；关闭 = 整门跳过但**不动任何验证记录**
    //（is_verified / verified_at 原样保留，重开后按记录与 TTL 判定）
    const enable = name === "/verifyon";
    await setVerificationEnabled(env.HODOR_DB, enable);
    await replyInTopic(
      env,
      chatId,
      threadId,
      enable ? formatVerifyOnConfirmed() : formatVerifyOffConfirmed(),
    );
    return;
  }

  if (name === "/verifymode") {
    // 无参循环切换（math ↔ button）。两步 setter **顺序 binding**：先
    // clearAllPendingVerifications 后 setVerificationMode——清题失败抛出时
    // settings 未变、旧题继续有效，无半切换态（旧题回调绝不误通过：归属
    // 判定 verify_msg_id 单道检查不变，被清空即落「题目已失效」分支）。
    // 两步非原子（D1 无跨语句事务）的已接受权衡：清题成功而 set 失败 →
    // settings 仍旧模式但旧题已清，用户下一条消息按旧模式出新题，安全
    // 无害；重推 / 再次执行 /verifymode 均收敛到一致态
    const { verifyMode } = await getVerificationSettings(env.HODOR_DB);
    const nextMode = verifyMode === "math" ? "button" : "math";
    await clearAllPendingVerifications(env.HODOR_DB);
    await setVerificationMode(env.HODOR_DB, nextMode);
    await replyInTopic(env, chatId, threadId, formatVerifyModeConfirmed(nextMode));
    return;
  }

  /* ------------- T38 /archive（需绑定：软归档，保留历史并清验证） ------------- */
  if (name === "/archive") {
    const owner = await findUserIdByThread(env.HODOR_DB, botId, threadId);
    if (!owner) {
      await replyInTopic(env, chatId, threadId, UNBOUND_TOPIC_NOTICE);
      return;
    }
    const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
    // 先向尚可写的 topic 发送操作说明；Telegram 明确规定 closed topic 不能再收消息。
    // 后续最终结果发往 General，TOPIC_NOT_MODIFIED 视为重推时已关闭的幂等成功。
    await replyInTopic(env, chatId, threadId, ARCHIVE_PREPARING_TEXT);
    const closed = await client.closeForumTopic({
      chat_id: chatId,
      message_thread_id: threadId,
    });
    const topicGone = !closed.ok && closed.kind === "permanent" && isTopicGoneError(closed.errorMessage);
    if (!closed.ok && closed.kind === "retryable") {
      throw new Error(closed.errorMessage ?? "closeForumTopic retryable");
    }
    if (!closed.ok && !topicGone && !isTopicNotModifiedError(closed.errorMessage)) {
      console.warn(
        `[commands] thread ${threadId}: archive closeForumTopic permanent，归档未写库：${closed.errorMessage ?? "no detail"}`,
      );
      await replyInGeneral(env, chatId, ARCHIVE_CLOSE_FAILED_TEXT);
      return;
    }

    // 软归档：用户行与 topic 绑定、账本、备注均保留；只清验证态、设置软删除标记。
    // setter 幂等，D1 中途失败后重推会再次完成；closeForumTopic already-closed 被视为成功。
    await markUnverified(env.HODOR_DB, botId, owner.user_id);
    await markUserDeleted(env.HODOR_DB, botId, owner.user_id);
    await closeTopic(env.HODOR_DB, botId, owner.user_id);
    // 置顶编辑在 close 后只是 best-effort 展示刷新；权限或 closed 限制失败不影响归档。
    await downgradePinnedToUnverified(env, client, botId, owner.user_id);

    let noticeFailed = false;
    const noticed = await client.sendMessage({ chat_id: owner.user_id, text: ARCHIVE_USER_NOTICE });
    if (!noticed.ok) {
      if (noticed.kind === "retryable") throw new Error(noticed.errorMessage ?? "sendMessage retryable");
      noticeFailed = true;
      console.warn(`[commands] user ${owner.user_id}: archive DM notice permanent: ${noticed.errorMessage ?? "no detail"}`);
    }
    await replyInGeneral(
      env,
      chatId,
      `${ARCHIVE_SUCCESS_TEXT}${topicGone ? " 原话题已不存在，用户回访时会自动创建替代话题。" : ""}${noticeFailed ? " 私聊提示未送达。" : ""}`,
    );
    return;
  }

  /* ------------- T38 /deluser（物理删除，二次确认） ------------- */
  if (name === "/deluser") {
    const owner = await findUserIdByThread(env.HODOR_DB, botId, threadId);
    if (!owner) {
      await replyInTopic(env, chatId, threadId, UNBOUND_TOPIC_NOTICE);
      return;
    }
    const startedAt = Math.floor(Date.now() / 1000);
    const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
    const prompt = await client.sendMessage({
      chat_id: chatId,
      message_thread_id: threadId,
      text: DELUSER_WARNING_TEXT,
      reply_markup: buildDeluserKeyboard(owner.user_id, threadId, startedAt),
    });
    if (!prompt.ok) {
      if (prompt.kind === "retryable") throw new Error(prompt.errorMessage ?? "sendMessage retryable");
      console.warn(`[commands] thread ${threadId}: 删除确认发送 permanent，跳过：${prompt.errorMessage ?? "no detail"}`);
      return;
    }
    // 按钮消息 ID 是一次确认的身份；落库失败时已发出的按钮无法通过确认校验。
    await saveDeleteConfirmation(env.HODOR_DB, botId, prompt.result.message_id, owner.user_id, threadId, startedAt);
    return;
  }

  /* ------------- T39 /purgemsg（需绑定，/ban 同姿态） ------------- */
  if (name === "/purgemsg") {
    const owner = await findUserIdByThread(env.HODOR_DB, botId, threadId);
    if (!owner) {
      await replyInTopic(env, chatId, threadId, UNBOUND_TOPIC_NOTICE);
      return;
    }
    // 反查命中保证正向行存在（同一 PK）；取 pinned_msg_id 并入删除列表
    //（置顶信息是系统消息、不入账本，账本查不到它）
    const topic = await findTopicByUser(env.HODOR_DB, botId, owner.user_id);
    const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
    const ids = await listThreadGroupMsgIds(env.HODOR_DB, botId, threadId);
    if (topic?.pinned_msg_id != null && !ids.includes(topic.pinned_msg_id)) {
      ids.push(topic.pinned_msg_id);
    }
    // 升序删除（账本查询已有序，并入置顶后重排）：确定性行为便于日志 / 断言
    ids.sort((a, b) => a - b);
    // 逐条删除 + 三态计数（不把未删除内容标为已清空）：
    // retryable → 抛交重推（重推重跑：已删的收敛为「已不存在」类）
    let deleted = 0;
    let gone = 0;
    let failed = 0;
    for (const messageId of ids) {
      const result = await client.deleteMessage({ chat_id: chatId, message_id: messageId });
      if (result.ok) {
        deleted++;
        continue;
      }
      if (result.kind === "retryable") {
        throw new Error(result.errorMessage ?? "deleteMessage retryable");
      }
      if (isMessageGoneError(result.errorMessage)) {
        gone++;
      } else {
        failed++;
        console.warn(
          `[commands] thread ${threadId}: deleteMessage(${messageId}) permanent：${result.errorMessage ?? "no detail"}`,
        );
      }
    }
    // 账本与置顶重置（无论 partial failure——已删 / 不存在的行不再追踪；
    // 失败未删的消息交管理员手动删除，确认文案已注明）
    await deleteThreadMessages(env.HODOR_DB, botId, threadId);
    await clearPinnedMsgId(env.HODOR_DB, botId, owner.user_id);
    // 立即重发信息卡并重新置顶（4a 同链）：compose 为 null（行缺失竞态）→
    // 跳过重发，pinned_msg_id 已 null，下次消息 4a 自然补；pinUserCard 返回
    // 是否完成置顶（send permanent warn 吞 → false）——确认文案据此措辞
    let pinnedReset = false;
    const cardText = await composePinnedText(env.HODOR_DB, botId, owner.user_id);
    if (cardText !== null) {
      pinnedReset = await pinUserCard(env, client, {
        botId,
        userId: owner.user_id,
        supportChatId: chatId,
        threadId,
        text: cardText,
      });
    }
    await replyInTopic(
      env,
      chatId,
      threadId,
      formatPurgeConfirmed({ deleted, gone, failed, pinnedReset }),
    );
    return;
  }

  /* ------------- T40 /wipealldata（全局命令，/help 同姿态无需绑定） ------------- */
  if (name === "/wipealldata") {
    // 第一步只发警告 + 确认键盘（60 秒窗口编入 callback_data，无服务端状态）；
    // 真正执行在确认回调（pipeline/wipe.ts，含再次鉴权与超时判定）
    await replyInTopic(
      env,
      chatId,
      threadId,
      WIPE_WARNING_TEXT,
      buildWipeKeyboard(Math.floor(Date.now() / 1000)),
    );
    return;
  }

  // 未知命令（含 /、/foo、群内误用的 /start 等）：提示管理员并引导 /help
  await replyInTopic(env, chatId, threadId, UNKNOWN_COMMAND_NOTICE);
}
