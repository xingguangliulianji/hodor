/**
 * 入站管线（T19/T20/T21 + T22–T25 + 阶段 4 三门 T28/T29/T35 + 阶段 5 M2
 * 置顶治理行 / 高危提醒）：
 *
 * 1. extractContent → 支持集之外（audio 之外的音乐类 / video_note / …）静默完成，零副作用
 * 2. from 校验（缺 id → 静默完成）
 * 3. ensureUser → { isNew, displayChanged, firstSeenAt } + 治理快照
 *    （isBanned / isVerified / isRisk / verifyAnswer / verifyMsgId）+
 *    getVerificationSettings 每消息一次（置顶三态 / M3 门 ②）
 * ①封禁门 isBanned → 拦截 + claimNoticeSlot 赢得才发 BAN_NOTICE（T30 频控）；
 *    封禁用户零验证 / 限频逻辑、零 topic 副作用、零账本
 * ②验证门（T27/T28 + T31 开关 + T33 TTL）：
 *    settings.verifyEnabled=false → **整门跳过**（门位置与门序不动——不删
 *    任何记录、不判定 TTL，未验证用户直接落 ③ 限频门；首联包欢迎语随门
 *    一起跳过，仅 isStart 用户在 ④ 仍可获欢迎语）
 *    开启且 (!isVerified 或 TTL 过期) → （过期先 markUnverified + 置顶降级 ❌
 *    best-effort）+ 欢迎语（isNew / isStart，slot 门控——阶段 3 语义）+
 *    验证题（首联包 isNew 不占 slot 与欢迎成对；存量 / pending 重出 slot
 *    门控——赢才出换题防死锁，输静默；题面随 settings.verifyMode 模式化）；
 *    本条丢弃（/start 亦如此）
 * ③限频门 countMessageInWindow 超限 → markUnverified + 置顶降级 ❌
 *    （downgradePinnedToUnverified 共享助手，best-effort）
 *    + slot 赢得才发「含限频数字 + 新题 + 按钮」合并消息（单 push）；本条丢弃
 * ④通过三门 → 阶段 3 链原样：
 *    topic 解析（open 复用 / closed 重开 / 新建 + 竞态清理）
 *      4a. pinned_msg_id === null → 发用户信息并置顶（高危 / 备注行随库内
 *          真值；验证行三态——开关关闭恒「未启用」，开启时三门后恒 ✅）
 *      4b. pinned 且 displayChanged → editMessageText 刷新（同款文本，best-effort）
 *    欢迎语（仅 isStart 可达：新用户一律先落验证门；slot 门控）
 *    /start 短路（入口命令非对话内容，不中继不写账本）
 *    中继 relayContent → 账本 insertMessage
 *    8. isRisk && claimRiskNoticeSlot 赢得 → topic 内高危提醒（T37，24h 一次；
 *       完全 best-effort，绝不放大用户消息重发面）
 *
 * 门序固定：封禁 → 验证 → 限频（封禁不消耗验证 / 限频逻辑；未验证消息不进
 * 限频计数）。三门在建档之后、topic 之前；被任一门拦截 = 零 topic 副作用、
 * 零账本，按成功处理（webhook markProcessed + 200，不积压补发——答题前被
 * 丢弃的消息不回溯，T28）。
 *
 * 逐步失败语义（design.md §四 + 阶段 3 表格，binding）：
 * | 步骤                | retryable                    | permanent                          |
 * | ①禁言提示            | 抛（slot 已耗，宁丢一条）      | warn 吞                            |
 * | ②欢迎语 / 验证题      | 抛（同上——重推出题，旧题失效） | warn 吞（题不落库）                 |
 * | ②TTL 撤验证（DB）     | 抛（重推落回验证门继续出题）    | —（D1 统一按 retryable）           |
 * | ②TTL 置顶降级         | warn 跳过（best-effort，同 ③） | 同左                               |
 * | ③置顶降级            | warn 跳过（best-effort）      | 同左                               |
 * | ③超限合并消息         | 抛（slot 已耗）               | warn 吞（题不落库）                 |
 * | 4a 置顶 send         | 抛（重推重走 4a，不重建 topic）| warn 跳过，**不写** pinned_msg_id |
 * | 4a pin              | 抛（同上）                    | warn，信息消息已在，**仍写**       |
 * | 4b 刷新置顶          | warn 跳过（best-effort）      | 同左                               |
 * | ④欢迎语（start 载体） | 抛（slot 已占，可能丢失）      | warn 跳过                          |
 * | ④中继               | 抛（→ 重推）                  | warn 跳过=丢弃，**不写账本**       |
 * | ④账本               | 抛（→ 重推；可能重发一次中继） | —（D1 错误统一按 retryable 抛）    |
 * | 8 高危提醒           | **warn 吞（完全 best-effort）** | 同左                             |
 *
 * ③的置顶降级排在合并消息之前且 best-effort：撤验证后重推只会落回验证门
 * （②），永远不会再走到③——降级必须在本轮完成，失败也不抛断主流程。
 * ② TTL 撤验证同构：markUnverified DB 真值先行，撤了再降级 / 出题，重推
 * 落回本门继续出题流程，无振荡。
 * 8 的高危提醒排在账本之后：中继 / 账本是主链，治理提醒是附着物——提醒
 * 失败绝不连带重推（重推会重发一次用户消息，at-least-once 已有代价不再放大）。
 */
import {
  BAN_NOTICE,
  DEFAULT_WELCOME_TEXT,
  formatPinnedInfo,
  formatRiskTopicNotice,
  isStartCommand,
} from "../copy";
import { parseMaxMessagesPerMinute, parseSupportChatId, parseVerifyTtlHours, parseWelcomeText } from "../env";
import { insertMessage } from "../store/messages";
import { getVerificationSettings } from "../store/settings";
import { isoBefore } from "../store/util";
import {
  deleteTopicBinding,
  findTopicByUser,
  insertTopic,
  isUniqueViolation,
  reopenTopic,
  type TopicRow,
} from "../store/topics";
import {
  claimNoticeSlot,
  claimRiskNoticeSlot,
  countMessageInWindow,
  ensureUser,
  markUnverified,
  markUserActive,
} from "../store/users";
import { createTelegramClient } from "../telegram/client";
import type { TelegramClient } from "../telegram/types";
import { sendVerificationCode } from "./verify";
import { composePinnedText, downgradePinnedToUnverified, pinUserCard } from "./pinned";
import {
  isTopicClosedError,
  isTopicGoneError,
  isTopicNotModifiedError,
} from "./errors";
import { extractContent, relayContent } from "./content";
import type { TelegramMessageRef } from "./classify";

/**
 * 展示名三级回退：first_name → @username → ID_<user_id>。topic title（建档时
 * 定死，不再复算）与高危提醒（T37，取当前消息展示字段）共用同一链路。
 */
function resolveDisplayName(from: { id: number; first_name?: string; username?: string }): string {
  const firstName = from.first_name?.trim();
  if (firstName) return firstName;
  if (from.username) return `@${from.username}`;
  return `ID_${from.id}`;
}

/**
 * 欢迎语（T23，claimNoticeSlot 原子频控；T30 起与其他提示共享 slot）。
 * 验证门（首联 / 未验证 start）与阶段 3 链（已验证 start）共用同一语义：
 * retryable → 抛（slot 已被占：重推不再补发，宁可丢失也不重复轰炸）；
 * permanent → warn 跳过。
 */
async function maybeSendWelcome(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  userId: number,
): Promise<void> {
  if (!(await claimNoticeSlot(env.HODOR_DB, botId, userId))) return;
  // 文案可用环境变量 WELCOME_TEXT 覆盖（字面 \n 解释为换行），未配置兜底默认
  const welcomeText = parseWelcomeText(env) ?? DEFAULT_WELCOME_TEXT;
  const welcome = await client.sendMessage({ chat_id: userId, text: welcomeText });
  if (!welcome.ok) {
    if (welcome.kind === "retryable") {
      throw new Error(welcome.errorMessage ?? "sendMessage retryable");
    }
    console.warn(
      `[inbound] user ${userId}: 欢迎语 permanent，跳过：${welcome.errorMessage ?? "no detail"}`,
    );
  }
}

/**
 * 处理一条私聊 message：建档 → 三门（封禁 / 验证 / 限频）→ 阶段 3 链
 * （topic+置顶 → 欢迎语 → 中继 → 账本）。
 * 完成（resolve）= 按成功处理；抛出（reject）= retryable，交 webhook 500 重推。
 */
export async function handleInbound(
  env: Cloudflare.Env,
  botId: number,
  message: TelegramMessageRef,
): Promise<void> {
  // 防御：classify 已对 supportChatId===null fail-closed，正常到不了这里；
  // 真到了说明部署配置坏了——按 retryable 处理让 5xx 暴露问题
  const supportChatId = parseSupportChatId(env);
  if (supportChatId === null) throw new Error("inbound: SUPPORT_CHAT_ID 无效");

  // 1. 支持集之外 / 畸形内容 → 静默完成（先于一切副作用：不建档、不建 topic）
  const payload = extractContent(message);
  if (payload === null) return;
  // 2. 私聊 message 必带 from；缺 from 视为畸形信封，静默完成零副作用
  const from = message.from;
  if (!from || typeof from.id !== "number") return;

  // 3. 建档 / 刷新（治理列不动；快照驱动三门；firstSeenAt 供置顶信息）
  const userState = await ensureUser(env.HODOR_DB, botId, from);

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const isStart = payload.type === "text" ? isStartCommand(payload.text) : false;
  // 验证配置每消息一次读取（design：不缓存——命令切换即时生效）：M2 供置顶
  // 验证行三态映射，M3 起供门 ② 开关 / TTL 判定
  const settings = await getVerificationSettings(env.HODOR_DB);

  /* ---------------- ① 封禁门（T35）：banned → 拦截 + 频控禁言提示 ---------------- */
  if (userState.isBanned) {
    if (await claimNoticeSlot(env.HODOR_DB, botId, from.id)) {
      const notice = await client.sendMessage({ chat_id: from.id, text: BAN_NOTICE });
      if (!notice.ok) {
        if (notice.kind === "retryable") {
          // slot 已被占：重推不再补发（宁丢一条提示，绝不轰炸）
          throw new Error(notice.errorMessage ?? "sendMessage retryable");
        }
        console.warn(
          `[inbound] user ${from.id}: 禁言提示 permanent，跳过：${notice.errorMessage ?? "no detail"}`,
        );
      }
    }
    return;
  }

  /* ---------------- ② 验证门（T27/T28 + T31 开关 + T33 TTL） ---------------- */
  // 开关关闭 → 整门跳过（门未删除，门序不动）：不删任何验证记录、不判定
  // TTL（关闭期间不消耗有效期——重开后按库内 verified_at 与当前 TTL 判定），
  // 未验证用户直接落 ③ 限频门（限频语义独立于验证开关，见 ③ 注释）
  if (settings.verifyEnabled) {
    // TTL 过期判定（T33）：VERIFY_TTL_HOURS * 3600s；ISO 字典序比较（util
    // 契约），恰好等于（verifiedAt ≤ now−ttl）视为过期（PRD 边界语义）。
    // verifiedAt 为 null 而 isVerified=1 的脏态（理论不可达）→ 不视为过期：
    // 防御式 fail-open，不因脏数据误伤已验证用户
    const ttlMs = parseVerifyTtlHours(env) * 3600_000;
    const expired =
      ttlMs > 0 &&
      userState.verifiedAt !== null &&
      userState.verifiedAt <= isoBefore(ttlMs);
    if (!userState.isVerified || expired) {
      if (expired) {
        // TTL 撤验证（T33）：DB 真值先行——markUnverified 一步清 is_verified /
        // verified_at / 题目字段；置顶降级 ❌ 复用 ③ 的共享助手（best-effort，
        // 失败不阻断出题——撤验证后重推只会落回本门继续出题流程，无振荡）
        await markUnverified(env.HODOR_DB, botId, from.id);
        await downgradePinnedToUnverified(env, client, botId, from.id);
      }
      // 欢迎语：isNew（首联包前半）或 isStart —— 阶段 3 语义不变（slot 门控）
      if (userState.isNew || isStart) {
        await maybeSendWelcome(env, client, botId, from.id);
      }
      // 出题策略：isNew 首联包不占 slot（与欢迎语成对发出）；存量未验证（无题 /
      // 有 pending）一律 slot 门控重出**新题**——赢才出（重发节流，T30），输静默；
      // 题面随 settings.verifyMode 模式化（T32，sendVerificationCode 内读取）
      if (userState.isNew || (await claimNoticeSlot(env.HODOR_DB, botId, from.id))) {
        await sendVerificationCode(env, botId, from.id, { type: "question" });
      }
      // 丢弃：不建 topic、不置顶、不中继、不写账本（/start 亦如此）；被丢弃的
      // 消息不积压补发——通过验证后的新消息才进入正常管线
      return;
    }
  }

  /* ---------------- ③ 限频门（T29）：固定窗口，超限 → 撤验证重验，本条丢弃 ---------------- */
  const limit = parseMaxMessagesPerMinute(env);
  if (!(await countMessageInWindow(env.HODOR_DB, botId, from.id, limit))) {
    await markUnverified(env.HODOR_DB, botId, from.id);
    // 置顶降级 ❌（best-effort，两种失败都 warn）：撤验证后重推只会落回验证门，
    // 不会再走到本门——降级必须本轮完成；无 topic / 未置顶则跳过。共享助手
    // 从库内真值组装（ensureUser 已刷新展示列）并强制 ❌（pinned.ts）
    await downgradePinnedToUnverified(env, client, botId, from.id);
    // 合并消息（提示含 limit 数字 + 新题 + 按钮，单 push）——slot 赢得才发，
    // 输则静默（持续刷消息不产生持续回复；重验入口由 60s 后的下一条消息提供）
    if (await claimNoticeSlot(env.HODOR_DB, botId, from.id)) {
      await sendVerificationCode(env, botId, from.id, { type: "overflow", limit });
    }
    return;
  }

  /* ---------------- ④ 阶段 3 链（三门全过；以下逻辑不变） ---------------- */
  let topic = await resolveTopic(env, client, {
    botId,
    userId: from.id,
    supportChatId,
    title: resolveDisplayName(from),
  });
  // null = createForumTopic permanent（topic 未建），本条按已处理丢弃（阶段 2 语义）
  if (topic === null) return;
  let currentTopic = topic;

  /**
   * 置顶信息正文（昵称用本次消息的最新展示字段 + 库内建档时间）：
   * 高危 / 备注行接库内真值（快照 isRisk + topic 行 note——新建 topic 的
   * note 恒 null）；验证行三态：开关关闭恒「未启用」（覆盖真值），开启时
   * 三门已过恒 ✅（存量置顶由答题 / 降级 / 命令刷新路径同步）。
   */
  const pinnedText = () =>
    formatPinnedInfo({
      id: from.id,
      first_name: from.first_name,
      last_name: from.last_name,
      username: from.username,
      firstSeenAt: userState.firstSeenAt,
      verify: settings.verifyEnabled ? "verified" : "disabled",
      isRisk: userState.isRisk,
      note: currentTopic.note,
    });

  /* ---------------- 4a / 4b：用户信息置顶（T24） ---------------- */
  if (currentTopic.pinned_msg_id === null) {
    await pinUserCard(env, client, {
      botId,
      userId: from.id,
      supportChatId,
      threadId: currentTopic.thread_id,
      text: pinnedText(),
    });
  } else if (userState.displayChanged) {
    // 4b 昵称变更刷新：best-effort——两种失败都只 warn，下次变更再试
    const edited = await client.editMessageText({
      chat_id: supportChatId,
      message_id: currentTopic.pinned_msg_id,
      text: pinnedText(),
    });
    if (!edited.ok) {
      console.warn(
        `[inbound] user ${from.id}: 置顶信息刷新失败（best-effort 跳过）：${edited.errorMessage ?? "no detail"}`,
      );
    }
  }

  /* ---------------- 5. 欢迎语（T23；仅 isStart 可达——新用户一律先落验证门） ---------------- */
  if (isStart) {
    await maybeSendWelcome(env, client, botId, from.id);
  }

  /* ---------------- 6. 中继（/start 短路；其余 per-type send 干净渲染） ---------------- */
  // isStartCommand 命中的所有变体（/start、/start@bot、/start payload）是纯入口 /
  // 控制命令而非对话内容：新 topic 出现 + 置顶即首联信号，不把 start 文本刷进
  // topic（2026-09-30 真机验收修正）；payload 变体 v1 无深链场景，一并跳过。
  // 短路 = 静默完成（update 照常 processed），中继与账本（第 7 步）都不执行。
  if (isStart) return;

  let relayed = await relayContent(client, payload, {
    chatId: supportChatId,
    threadId: currentTopic.thread_id,
  });
  if (!relayed.ok && relayed.kind === "retryable") {
    throw new Error(relayed.errorMessage ?? "relay retryable");
  }

  // 若 native close service update 尚未到达 / DB 状态落后，closed topic 的
  // TOPIC_CLOSED permanent 仍按「关闭」处理（绝不删除 binding）：显式重开后
  // 把同一条当前消息重试一次。Telegram 官方定义 closed topic 不接受消息，
  // 所以回访恢复是 Hodor 调 reopenForumTopic 的受控行为。
  if (!relayed.ok && isTopicClosedError(relayed.errorMessage)) {
    const reopened = await client.reopenForumTopic({
      chat_id: supportChatId,
      message_thread_id: currentTopic.thread_id,
    });
    if (!reopened.ok && reopened.kind === "retryable") {
      throw new Error(reopened.errorMessage ?? "reopenForumTopic retryable");
    }
    if (!reopened.ok && !isTopicNotModifiedError(reopened.errorMessage)) {
      if (isTopicGoneError(reopened.errorMessage)) {
        relayed = { ok: false, kind: "permanent", errorMessage: reopened.errorMessage };
      } else {
        console.warn(
          `[inbound] user ${from.id}: TOPIC_CLOSED 后 reopenForumTopic permanent，保留绑定并丢弃本条：${reopened.errorMessage ?? "no detail"}`,
        );
        return;
      }
    } else {
      await markUserActive(env.HODOR_DB, botId, from.id);
      await reopenTopic(env.HODOR_DB, botId, from.id);
      relayed = await relayContent(client, payload, {
        chatId: supportChatId,
        threadId: currentTopic.thread_id,
      });
      if (!relayed.ok && relayed.kind === "retryable") {
        throw new Error(relayed.errorMessage ?? "reopened relay retryable");
      }
    }
  }

  if (!relayed.ok && isTopicGoneError(relayed.errorMessage)) {
    // 原生删除自愈：回收死映射、建替代 topic，并把同一 payload 重发一次；
    // 当前消息尽量保留。note 随旧映射丢失，历史账本保留。
    const deletedThread = currentTopic.thread_id;
    await deleteTopicBinding(env.HODOR_DB, botId, from.id);
    console.warn(
      `[inbound] user ${from.id}: thread ${deletedThread} 已不存在，回收绑定并为当前消息创建替代 topic`,
    );
    const replacement = await resolveTopic(env, client, {
      botId,
      userId: from.id,
      supportChatId,
      title: resolveDisplayName(from),
    });
    if (replacement === null) return;
    currentTopic = replacement;
    const replacementCard = await composePinnedText(env.HODOR_DB, botId, from.id);
    if (replacementCard !== null) {
      await pinUserCard(env, client, {
        botId,
        userId: from.id,
        supportChatId,
        threadId: currentTopic.thread_id,
        text: replacementCard,
      });
    }
    relayed = await relayContent(client, payload, {
      chatId: supportChatId,
      threadId: currentTopic.thread_id,
    });
    if (!relayed.ok && relayed.kind === "retryable") {
      throw new Error(relayed.errorMessage ?? "replacement relay retryable");
    }
    if (!relayed.ok && isTopicGoneError(relayed.errorMessage)) {
      await deleteTopicBinding(env.HODOR_DB, botId, from.id);
      console.warn(
        `[inbound] user ${from.id}: replacement thread ${currentTopic.thread_id} 也不存在，本条丢弃且不继续重建`,
      );
      return;
    }
  }
  if (!relayed.ok) {
    // 其余 permanent 不是可确认的 close/delete 事件：保留绑定并警告，不写账本。
    console.warn(
      `[inbound] user ${from.id}: 中继 permanent，按已处理跳过（消息被丢弃，不写账本）：${relayed.errorMessage ?? "no detail"}`,
    );
    return;
  }

  /* ---------------- 7. 账本（T25；失败原样抛 → 重推可能重发一次中继） ---------------- */
  await insertMessage(env.HODOR_DB, {
    botId,
    userId: from.id,
    threadId: currentTopic.thread_id,
    direction: "in",
    groupMsgId: relayed.result.message_id,
    privateMsgId: message.message_id,
    contentType: payload.type,
  });

  /* ------------- 8. 高危 24h 一次性提醒（T37；账本后附着物，完全 best-effort） ------------- */
  // 排序（design §三）：中继 / 账本是主链，治理提醒是附着物——放最后，两种
  // 失败均 warn 吞，绝不抛（提醒 429 → 整条重推 → 用户消息重发的放大面为零）；
  // /start 短路在第 6 步已 return，本提醒只附着在成功中继 + 账本之后。
  // claimRiskNoticeSlot 原子裁决（WHERE 带 is_risk=1）：24h 窗口内仅一条，
  // /risk 重新标记后窗口重置（setter 已清 risk_notice_at）。slot 已耗而
  // 发送失败时本轮提醒丢失，24h 后由下一条消息补上（已接受语义）。
  // 提醒是系统消息：不入 messages 账本。
  if (userState.isRisk && (await claimRiskNoticeSlot(env.HODOR_DB, botId, from.id))) {
    const notice = await client.sendMessage({
      chat_id: supportChatId,
      text: formatRiskTopicNotice(resolveDisplayName(from)),
      message_thread_id: currentTopic.thread_id,
    });
    if (!notice.ok) {
      console.warn(
        `[inbound] user ${from.id}: 高危提醒发送失败（best-effort 跳过）：${notice.errorMessage ?? "no detail"}`,
      );
    }
  }
}

/** 竞态清理的上下文（createTopic 主流程 + 失败路径共用） */
interface CreateTopicContext {
  botId: number;
  userId: number;
  supportChatId: number;
  title: string;
}

/**
 * topic 解析（阶段 2 逻辑 + 阶段 6 T38 真重开 / 原生删除自愈）：
 *
 * - open 行 → 直接复用；
   * - closed 行（native close / /archive）→ **API 先行**（reopenForumTopic ok
   *   才动 DB——retryable 抛出时 DB 仍 closed，重推原样重入本分支重试，无半开窗口）：
 *   reopenTopic + markUserActive（users.status 复位，成对写、幂等）后返回
 *   原行（pinned_msg_id / note 保留，重开不重发置顶）；
 *   reopenForumTopic permanent 且 topic-gone（原生删除）→ deleteTopicBinding
 *   回收死绑定 → createTopicWithRaceCleanup **立即建新 topic（本条不丢）**；
 *   其他 permanent → warn 丢本条（同 createForumTopic permanent 语义，
 *   不把可恢复的配置问题误判为死绑定）；
 * - 未命中 → 建 topic 主流程（含并发首联竞态的败方清理）。
 */
async function resolveTopic(
  env: Cloudflare.Env,
  client: TelegramClient,
  ctx: CreateTopicContext,
): Promise<TopicRow | null> {
  const existing = await findTopicByUser(env.HODOR_DB, ctx.botId, ctx.userId);
  if (existing && existing.status === "open") {
    // Native topic re-open may be the user's first activity after /archive.
    // A successfully routed inbound message ends the soft-delete lifecycle.
    await markUserActive(env.HODOR_DB, ctx.botId, ctx.userId);
    return existing;
  }
  if (existing) {
    // closed：终身一个 topic，重开复用（原生 close / /archive 后都必须真调用
    // reopenForumTopic——仅改 DB 状态会让后续中继全部落空）
    const reopened = await client.reopenForumTopic({
      chat_id: ctx.supportChatId,
      message_thread_id: existing.thread_id,
    });
    if (!reopened.ok && !isTopicNotModifiedError(reopened.errorMessage)) {
      if (reopened.kind === "retryable") {
        // DB 仍 closed：重推原样重入本分支重试 reopen（无半开窗口）
        throw new Error(reopened.errorMessage ?? "reopenForumTopic retryable");
      }
      if (isTopicGoneError(reopened.errorMessage)) {
        // topic 已被原生删除：回收死绑定，本条消息直接落新 topic。用户事实上
        // 回来了——status 先于删行复位（幂等 setter 顺序：markUserActive 失败
        // 抛出时绑定仍在、重推原样重入本分支重试；反之 status 会永久残留
        // deleted——重推时行已删、直落建 topic 分支不再经过此处）
        console.warn(
          `[inbound] user ${ctx.userId}: 重开 thread ${existing.thread_id} 失败（topic 已被删除），回收绑定并新建 topic`,
        );
        await markUserActive(env.HODOR_DB, ctx.botId, ctx.userId);
        await deleteTopicBinding(env.HODOR_DB, ctx.botId, ctx.userId);
        return createTopicWithRaceCleanup(env, client, ctx);
      }
      // 其他 permanent：丢弃本条（下一条消息重试 reopen），绝不误删绑定
      console.warn(
        `[inbound] user ${ctx.userId}: reopenForumTopic permanent，本条丢弃（绑定保留）：${reopened.errorMessage ?? "no detail"}`,
      );
      return null;
    }
    // status 先于行重开复位（幂等 setter 顺序，同上分支理由：reopenTopic 成功
    // 而 markUserActive 失败抛出时，重推走 open 复用分支、status 永久残留）
    await markUserActive(env.HODOR_DB, ctx.botId, ctx.userId);
    await reopenTopic(env.HODOR_DB, ctx.botId, ctx.userId);
    return existing;
  }
  return createTopicWithRaceCleanup(env, client, ctx);
}

/** 未命中映射时的建 topic 主流程失败语义（阶段 2 不变） */
async function createTopicWithRaceCleanup(
  env: Cloudflare.Env,
  client: TelegramClient,
  ctx: CreateTopicContext,
): Promise<TopicRow | null> {
  const created = await client.createForumTopic({
    chat_id: ctx.supportChatId,
    name: ctx.title,
  });
  if (!created.ok) {
    if (created.kind === "retryable") {
      throw new Error(created.errorMessage ?? "createForumTopic retryable");
    }
    // permanent：无 topic 可用，本条消息按已处理丢弃（阶段 2 语义，不 5xx）
    console.warn(
      `[inbound] user ${ctx.userId}: createForumTopic permanent，topic 未建、消息被丢弃：${created.errorMessage ?? "no detail"}`,
    );
    return null;
  }
  const newThreadId = created.result.message_thread_id;

  try {
    await insertTopic(env.HODOR_DB, {
      botId: ctx.botId,
      userId: ctx.userId,
      threadId: newThreadId,
      title: ctx.title,
    });
    // 新建行 pinned_msg_id / note 必为 null（由 4a 判定驱动置顶；备注 M2 起接真值）
    return { thread_id: newThreadId, title: ctx.title, status: "open", pinned_msg_id: null, note: null };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // 竞态败方：胜方已写入映射，清掉自己刚建的群 topic
    console.warn(
      `[inbound] user ${ctx.userId}: topic 映射竞态，败方清理 thread ${newThreadId}`,
    );
    const deleted = await client.deleteForumTopic({
      chat_id: ctx.supportChatId,
      message_thread_id: newThreadId,
    });
    if (!deleted.ok) {
      console.warn(
        `[inbound] user ${ctx.userId}: 败方 deleteForumTopic(${newThreadId}) 未成功（孤儿 topic 交人工清理）：${deleted.errorMessage ?? "no detail"}`,
      );
    }

    const winner: TopicRow | null = await findTopicByUser(env.HODOR_DB, ctx.botId, ctx.userId);
    if (!winner) {
      // 唯一冲突却查无胜方行（如 (bot_id,thread_id) 撞上他行）：交给重推重建
      throw new Error("inbound: topic 竞态清理后仍未取得映射行");
    }
    // 胜方行的 pinned_msg_id 原样返回（胜方可能已置顶——不重复置顶）
    return winner;
  }
}
