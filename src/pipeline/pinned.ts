/**
 * 置顶信息组装 / 刷新共享助手（阶段 5 M2，design.md §二.7 / §二.9）：
 *
 * 置顶文本的字段来源此前散落在 inbound ②/③/④、verify 通过链、（M2 起）
 * commands 刷新——note / isRisk / verify 三态接入后每组调用点都要拼一遍
 * 「快照 + topic 行 + settings」的字段集，重复且易漂移。本模块收口：
 *
 * - composePinnedText：唯一组装点——users 行（治理快照：展示列 + isRisk +
 *   isVerified）+ topics 行（note）+ settings（verify 三态映射：disabled
 *   覆盖真值）→ formatPinnedText 文本；users 或 topics 行缺失 → null。
 *   可选 overrides 强制覆盖个别字段（超限 / TTL 降级必须显示 ❌，即便
 *   settings 为其他态）。
 * - editPinnedBestEffort：命令（/note /unnote /risk /unrisk）内置顶刷新——
 *   best-effort（design §三「命令内置顶刷新」行：确认回复已反馈，置顶是
 *   展示面，两种失败均 warn 吞，绝不放大用户消息重发面）。
 * - downgradePinnedToUnverified：inbound ③ 超限 / ② TTL 过期的置顶降级 ❌
 *   （同为 best-effort；强制 verify="unverified"）；T38 /archive 清验证后复用。
 * - pinUserCard（阶段 6 迁入）：4a 置顶流程唯一入口——inbound 首联与
 *   T39 /purgemsg 重置置顶共用同一「发信息卡 → pin → 落库」链。
 *
 * 系统消息语义（error-handling spec）：置顶编辑不入 messages 账本。
 */
import { formatPinnedInfo, type PinnedInfoUser } from "../copy";
import { parseSupportChatId } from "../env";
import { findTopicByUser, setPinnedMsgId } from "../store/topics";
import { getVerificationSettings } from "../store/settings";
import { getGovernanceSnapshot } from "../store/users";
import type { TelegramClient } from "../telegram/types";

/**
 * 组装某用户置顶信息正文（库内真值单一来源）。
 *
 * verify 三态映射：settings.verifyEnabled=false → "disabled"（关闭期间恒
 * 「未启用」，覆盖库内真值——此时无从谈验证状态）；开启时按快照 is_verified
 * 映射 "verified" / "unverified"。overrides 在组装结果上强制覆盖（如降级路径
 * 强制 ❌）——展开在最后，优先级最高。
 * users 行或 topics 行缺失 → null（无可组装的真值；调用方按需跳过）。
 */
export async function composePinnedText(
  db: D1Database,
  botId: number,
  userId: number,
  overrides?: Partial<PinnedInfoUser>,
): Promise<string | null> {
  const [snapshot, topic, settings] = await Promise.all([
    getGovernanceSnapshot(db, botId, userId),
    findTopicByUser(db, botId, userId),
    getVerificationSettings(db),
  ]);
  if (!snapshot || !topic) return null;
  return formatPinnedInfo({
    id: userId,
    first_name: snapshot.firstName,
    last_name: snapshot.lastName,
    username: snapshot.username,
    firstSeenAt: snapshot.firstSeenAt,
    verify: settings.verifyEnabled
      ? snapshot.isVerified
        ? "verified"
        : "unverified"
      : "disabled",
    isRisk: snapshot.isRisk,
    note: topic.note,
    ...overrides,
  });
}

/**
 * 置顶刷新内核：定位 pinned_msg_id → compose 组文本 → editMessageText。
 *
 * 跳过条件（零 API 调用）：无 topics 映射行 / pinned_msg_id 为 null（尚未
 * 置顶——下次 4a 自然带新值）/ compose 为 null（users 行缺失的竞态窗口）。
 * editMessageText 两种失败（retryable / permanent）均 console.warn 吞：
 * 置顶是 best-effort 展示面（design §三），调用方各自的确认 / 主链反馈
 * 不受影响。
 */
async function editPinned(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  userId: number,
  overrides?: Partial<PinnedInfoUser>,
): Promise<void> {
  // 防御：classify 对 SUPPORT_CHAT_ID===null fail-closed，正常到不了这里
  //（同 inbound / verify 姿态）——畸形即无处可 edit，跳过
  const supportChatId = parseSupportChatId(env);
  if (supportChatId === null) return;
  const topic = await findTopicByUser(env.HODOR_DB, botId, userId);
  if (!topic || topic.pinned_msg_id === null) return;
  const text = await composePinnedText(env.HODOR_DB, botId, userId, overrides);
  if (text === null) return;
  const edited = await client.editMessageText({
    chat_id: supportChatId,
    message_id: topic.pinned_msg_id,
    text,
  });
  if (!edited.ok) {
    console.warn(
      `[pinned] user ${userId}: 置顶刷新失败（best-effort 跳过）：${edited.errorMessage ?? "no detail"}`,
    );
  }
}

/**
 * 命令内置顶刷新（/note /unnote /risk /unrisk 在 setter 之后调用）：
 * best-effort——确认回复已保证管理员有反馈，置顶 edit 失败（含消息已被
 * 手工删除等 permanent）绝不阻断命令、绝不抛（重推会重发确认回复）。
 */
export async function editPinnedBestEffort(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  userId: number,
): Promise<void> {
  await editPinned(env, client, botId, userId);
}

/**
 * 置顶验证行降级 ❌（inbound ③ 超限撤验证后 / ② TTL 过期撤验证后 / T38
 * /archive 清验证后）：强制 verify="unverified"——降级时刻的置顶必须显示
 * ❌，即便 settings 已切到其他态（关闭态的「未启用」是门放行的展示，不是
 * 验证失败的展示）。best-effort 与 4b 刷新同款：两种失败均 warn 吞（降级
 * 失败不抛断主流程）。
 */
export async function downgradePinnedToUnverified(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  userId: number,
): Promise<void> {
  await editPinned(env, client, botId, userId, { verify: "unverified" });
}

/** 4a 置顶流程的上下文（inbound 首联 / T39 /purgemsg 重置置顶共用） */
export interface PinUserCardContext {
  botId: number;
  userId: number;
  supportChatId: number;
  threadId: number;
  text: string;
}

/**
 * 4a：在 topic 内发用户信息消息并置顶、落库（T24「每 topic 恰一条」的唯一
 * 入口；T39 起从 inbound 迁入本模块——/purgemsg 重置置顶与首联置顶同一
 * 语义，行为零变化）。
 *
 * 返回是否完成置顶并落库（/purgemsg 确认文案据此措辞，不虚报已重置）：
 * - 信息 send retryable → 抛（重推重走 4a：topic 已在、pinned_msg_id 仍 null，
 *   不重建 topic、不重发用户消息；极端窗口可能遗留一条未置顶的旧信息消息，
 *   接受并记录日志——design.md §四）
 * - 信息 send permanent → warn 跳过，**不写** pinned_msg_id（后续消息可再尝试）→ false
 * - pin permanent → warn，信息消息已在，**仍写** pinned_msg_id（供 4b edit 刷新）→ true
 */
export async function pinUserCard(
  env: Cloudflare.Env,
  client: TelegramClient,
  ctx: PinUserCardContext,
): Promise<boolean> {
  const sent = await client.sendMessage({
    chat_id: ctx.supportChatId,
    text: ctx.text,
    message_thread_id: ctx.threadId,
  });
  if (!sent.ok) {
    if (sent.kind === "retryable") throw new Error(sent.errorMessage ?? "sendMessage retryable");
    console.warn(
      `[pinned] user ${ctx.userId}: 置顶信息发送 permanent，跳过置顶（不落 pinned_msg_id）：${sent.errorMessage ?? "no detail"}`,
    );
    return false;
  }
  const pinnedMsgId = sent.result.message_id;

  const pinned = await client.pinChatMessage({
    chat_id: ctx.supportChatId,
    message_id: pinnedMsgId,
  });
  if (!pinned.ok) {
    if (pinned.kind === "retryable") throw new Error(pinned.errorMessage ?? "pinChatMessage retryable");
    console.warn(
      `[pinned] user ${ctx.userId}: pinChatMessage permanent（信息消息已在，仍记录 pinned_msg_id 供刷新）：${pinned.errorMessage ?? "no detail"}`,
    );
  }
  // 落库：D1 失败原样抛（→ retryable 重推；重推重走 4a 属已接受的极端窗口）
  await setPinnedMsgId(env.HODOR_DB, ctx.botId, ctx.userId, pinnedMsgId);
  return true;
}
