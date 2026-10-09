/**
 * 用户 / 管理员可见文案的唯一集中点（T23 / T24 / T26 + 阶段 4 T27/T29/T34/T35
 * + 阶段 5 T31/T32/T36/T37）。
 *
 * fork 可整体改写本模块（含多语言）——除本文件外，任何模块不得散落
 * 硬编码用户文案（PRD 约束）。文案定稿来源：docs/guide/features.md。
 * 带参数的文案一律用 format* 函数（fork 单点改写，调用方零文案）。
 */

/**
 * 默认欢迎语文案（features.md 定稿，三要素逐字一致：项目名称 / 使用方式 / 项目地址）。
 *
 * 可用环境变量 WELCOME_TEXT 整体覆盖（env.ts parseWelcomeText 解析，字面 \n
 * 解释为换行）；缺失 / 为空时兜底使用本默认文案。
 */
export const DEFAULT_WELCOME_TEXT = `你好，欢迎使用 hodor 私聊机器人！👋

直接发送消息即可与客服对话，无需任何命令；客服的回复也会在这里显示。

项目地址：https://github.com/huaiminyetnotsleep/hodor`;

/** 置顶验证行的三态（T31 开关交付起布尔真值升为三态） */
export type PinnedVerifyState = "verified" | "unverified" | "disabled";

/** formatPinnedInfo 所需的用户字段子集（users 行展示列 + 建档时间 + 治理行） */
export interface PinnedInfoUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  /** users.first_seen_at（ISO-8601 UTC 文本） */
  firstSeenAt: string;
  /**
   * 验证行三态（T31）：verified / unverified 按库内真值（users.is_verified），
   * disabled = 验证开关关闭期间（恒「未启用」，覆盖真值——此时无从谈验证状态）
   */
  verify: PinnedVerifyState;
  /** 高危标记（users.is_risk，T37）：true → 追加「高危：⚠️ 高危用户」行 */
  isRisk?: boolean;
  /** 管理员备注（topics.note，T36）：非空 → 追加「备注：<text>」行 */
  note?: string | null;
}

/** 三态验证行文案（disabled 无 emoji——验证未启用时绝不伪称任何状态） */
const VERIFY_STATUS_TEXT: Record<PinnedVerifyState, string> = {
  verified: "✅ 已验证",
  unverified: "❌ 未验证",
  disabled: "未启用",
};

/**
 * 置顶的用户信息（T24 + 阶段 4 验证行 + 阶段 5 高危 / 备注行）：
 * 昵称（含 @username 括注）/ 用户 ID / 首次聊天（截到分钟）/ 验证状态
 * （三态）/ 高危（仅 isRisk）/ 备注（仅非空）。
 *
 * - 昵称回退链：first+last_name → @username → ID_<id>；括注只在展示名来自
 *   姓名且存在 @username 时携带（否则会与回退名重复）
 * - 验证行三态（T31 开关交付起）：✅ 已验证 / ❌ 未验证 / 未启用
 *   （开关关闭期间恒「未启用」；答对 / 超限降级 / TTL 过期时 editMessageText 同步）
 * - 高危行仅 isRisk=true 时出现（`高危：⚠️ 高危用户`）；备注行仅 note 非空
 *   时出现——两行都在验证行之后，行序固定
 * - firstSeenAt 为 ISO 文本截到分钟（`YYYY-MM-DD HH:mm`）：D1 默认值与
 *   nowIso() 同构（`YYYY-MM-DDTHH:mm:ss.sssZ`），前 16 位切片即所需
 */
export function formatPinnedInfo(user: PinnedInfoUser): string {
  const names = [user.first_name?.trim(), user.last_name?.trim()].filter(
    (name): name is string => name !== undefined && name !== "",
  );
  const fromNames = names.length > 0 ? names.join(" ") : undefined;
  const displayName =
    fromNames ?? (user.username ? `@${user.username}` : `ID_${user.id}`);
  const handle = fromNames && user.username ? `（@${user.username}）` : "";
  const firstSeen = `${user.firstSeenAt.slice(0, 10)} ${user.firstSeenAt.slice(11, 16)}`;
  const lines = [
    `昵称：${displayName}${handle}`,
    `用户 ID：${user.id}`,
    `首次聊天：${firstSeen} (UTC)`,
    `验证状态：${VERIFY_STATUS_TEXT[user.verify]}`,
  ];
  if (user.isRisk) lines.push("高危：⚠️ 高危用户");
  const note = user.note?.trim();
  if (note) lines.push(`备注：${user.note}`);
  return lines.join("\n");
}

/**
 * 无绑定 topic 提示（T26）：管理员在无映射行 / closed 的 topic 内发言时，
 * 发回该 topic 的提示（绝不发往任何用户私聊）。/ban /unban 无绑定时复用（T35）。
 */
export const UNBOUND_TOPIC_NOTICE =
  "找不到对应用户：此话题没有有效绑定（可能从未建立或已被关闭），请勿在此继续回复。";

/**
 * /start 命令判定（T23）：`/start` 本身、`/start@bot`、`/start payload` 均算；
 * `/startups` 这类前缀巧合不算。undefined / 非命令 → false。
 */
export function isStartCommand(text: string | undefined): boolean {
  if (text === "/start") return true;
  return /^\/start(@\S+)?(\s|$)/.test(text ?? "");
}

/* ------------------------------------------------------------------ */
/* 阶段 4：验证（T27）/ 限频（T29）/ 封禁（T35）/ 命令（T34）文案        */
/* ------------------------------------------------------------------ */

/** 验证题题头（T27）：题面与超限合并消息共用，保证提示语义一致 */
export const VERIFY_QUESTION_HEADER = "为确认你是真人，请回答下面的算术题：";

/** 新题消息正文（T27）：题头 + 算式（expression 如 "3 + 5 = ?"） */
export function formatVerifyQuestion(expression: string): string {
  return `${VERIFY_QUESTION_HEADER}\n${expression}`;
}

/**
 * 答错重出的错误提示前缀（T27 + T32 模式化）：与 buildChallenge 产出的
 * 模式化题面拼接成重出正文（编辑到**同一题面消息**——无新推送，天然不占
 * 提示频控）。math 模式下拼接产物与下方 formatVerifyRetryQuestion 逐字一致。
 */
export const VERIFY_RETRY_PREFIX = "回答错误，请再试一次。\n\n";

/**
 * 答错重出正文（T27，math 模式定稿形态）：错误提示 + 新题（题头 + 算式）。
 */
export function formatVerifyRetryQuestion(expression: string): string {
  return `${VERIFY_RETRY_PREFIX}${formatVerifyQuestion(expression)}`;
}

/** 答错 toast（answerCallbackQuery 弹出，T27） */
export const VERIFY_WRONG_TOAST = "回答错误，请重试。";

/** 答对 toast（answerCallbackQuery 弹出，T27） */
export const VERIFY_PASSED_TOAST = "验证通过！";

/** 答对后题面消息的编辑文案（原位替换题面，T27） */
export const VERIFY_PASSED_TEXT = "✅ 验证通过，现在可以直接发送消息了。";

/** 旧题 / 他人 / 重放回调 toast（T27 归属判定拦截时弹出） */
export const VERIFY_EXPIRED_NOTICE = "题目已失效，请发送任意消息获取新题目。";

/**
 * 超限合并消息正文（T29）：限频提示（含 {limit} 数字）+ 新题，
 * 单条 push 发出（提示 + 题面 + 按钮同消息，只占一次提示频控）。
 */
export function formatRateLimitVerifyQuestion(limit: number, expression: string): string {
  return `发送过快，每分钟最多 ${limit} 条消息，本条未送达。请重新完成验证：\n\n${VERIFY_QUESTION_HEADER}\n${expression}`;
}

/**
 * 超限合并消息正文——纯按钮模式变体（T29 + T32）：限频提示前缀与数学题
 * 形态逐字一致（超限语义不随模式变化），题面换为纯按钮引导文案 + 单按钮
 * （按钮本体由 buildChallenge 组装，本函数只管文字）。
 */
export function formatRateLimitVerifyButton(limit: number): string {
  return `发送过快，每分钟最多 ${limit} 条消息，本条未送达。请重新完成验证：\n\n${formatVerifyButtonQuestion()}`;
}

/** 禁言提示（T35）：封禁门拦截用户消息时经提示频控发给用户 */
export const BAN_NOTICE = "你已被禁言，消息无法送达客服。如有疑问请通过其他方式联系。";

/**
 * /help 文案（T34 + T32 动态化）：只列**已交付**命令；验证段随当前开关与
 * 模式变化——只展示「可操作的那个」开关命令（开 → /verifyoff，关 →
 * /verifyon），未交付命令绝不提前展示。后续阶段新增命令时在此增行。
 */
export interface HelpSettings {
  verifyEnabled: boolean;
  verifyMode: "math" | "button";
}

/** 验证模式的帮助侧中文名（/verifymode 行与切换确认共用） */
export function verifyModeLabel(mode: "math" | "button"): string {
  return mode === "math" ? "数学题" : "纯按钮";
}

export function formatHelpText(settings: HelpSettings): string {
  const lines = [
    "可用命令：",
    "/help - 显示本帮助",
    "/ban - 禁言当前话题对应用户",
    "/unban - 解除当前话题对应用户的禁言",
    "/note <内容> - 添加用户备注",
    "/unnote - 清除用户备注",
    "/risk - 标记高危用户",
    "/unrisk - 取消高危标记",
    "/archive - 软归档当前用户（关闭话题，保留绑定、历史与备注）",
    "/deluser - 物理删除当前用户及群内话题（需二次确认；不删除私聊历史）",
    "/purgemsg - 清理本话题可追踪群消息并重置置顶（话题关闭时先在 Telegram 重开）",
    "",
    "验证：",
  ];
  if (settings.verifyEnabled) {
    // 开 → 唯一可操作的是关（/verifyon 不展示，避免管理员误以为未开）
    lines.push("/verifyoff - 临时关闭人机验证（已验证记录保留）");
  } else {
    lines.push("/verifyon - 开启人机验证", "当前验证已关闭。");
  }
  lines.push(
    `/verifymode - 切换验证模式（当前：${verifyModeLabel(settings.verifyMode)}）`,
    "纯按钮模式防护较弱，bot 可直接调 API 点击，仅建议受信任场景使用。",
    "",
    "危险操作：",
    "/wipealldata - 删除全部群内话题并清空全部用户数据（两步确认，不可恢复）",
    "",
    "说明：以 / 开头的消息不会中继给用户。",
  );
  return lines.join("\n");
}

/** 未知命令提示（T34）：回 topic 引导管理员查看 /help，绝不发用户 */
export const UNKNOWN_COMMAND_NOTICE = "未知命令，发送 /help 查看可用命令。";

/**
 * 非管理员命令提示（T34 真机验收增量，2026-09-30）：非管理员在客服群
 * topic 内发 `/` 命令时回发该 topic（原为静默——用户验收时要求可见反馈；
 * 非命令文本仍静默）。回 topic 不触达任何用户私聊。
 */
export const NOT_ADMIN_COMMAND_NOTICE = "该命令仅客服管理员可用。";

/**
 * 管理命令菜单（T34 真机验收增量，2026-09-30）：setwebhook 时经
 * setMyCommands 注册进 Telegram 命令菜单（客服群输入框可直接点选，不用
 * 手敲）。scope 恒为客服群 chat——用户私聊菜单不受影响。command 一律
 * 小写无斜杠（Telegram BotCommand 规范）。菜单**恒全量注册**（不随开关
 * 动态变化——Telegram 菜单是客户端缓存，动态化弊大于利；帮助文本才是
 * 动态面），并与 formatHelpText 的「已交付命令」清单保持同步。已部署
 * 实例需重跑 setwebhook 刷新菜单。
 */
export const ADMIN_COMMAND_MENU: readonly { command: string; description: string }[] = [
  { command: "help", description: "查看管理命令帮助" },
  { command: "ban", description: "封禁本话题用户" },
  { command: "unban", description: "解封本话题用户" },
  { command: "note", description: "添加用户备注" },
  { command: "unnote", description: "清除用户备注" },
  { command: "risk", description: "标记高危用户" },
  { command: "unrisk", description: "取消高危标记" },
  { command: "verifyon", description: "开启人机验证" },
  { command: "verifyoff", description: "临时关闭人机验证" },
  { command: "verifymode", description: "切换验证模式" },
  { command: "archive", description: "软归档本话题用户" },
  { command: "deluser", description: "物理删除用户及本话题（需确认）" },
  { command: "purgemsg", description: "清理本话题可追踪群消息" },
  { command: "wipealldata", description: "删除全部话题并清空数据（两步确认）" },
];

/** /ban 确认（T35）：回 topic，携带目标用户 ID 便于管理员核对 */
export function formatBanConfirmed(userId: number): string {
  return `已禁言用户 ${userId}：其后续消息将被拦截。`;
}

/** /unban 确认（T35）：回 topic */
export function formatUnbanConfirmed(userId: number): string {
  return `已解除用户 ${userId} 的禁言。`;
}

/* ------------------------------------------------------------------ */
/* 阶段 5：备注（T36）/ 高危（T37）/ 验证开关与模式（T31/T32）文案        */
/* ------------------------------------------------------------------ */

/** /note 确认（T36）：回 topic，回显写入的备注便于管理员核对 */
export function formatNoteConfirmed(note: string): string {
  return `已添加备注：${note}`;
}

/** /unnote 确认（T36）：回 topic */
export function formatUnnoteConfirmed(): string {
  return "已清除备注。";
}

/** /note 缺参数的用法提示（T36）：绝不误写空备注 */
export const NOTE_USAGE_NOTICE = "用法：/note <内容>（备注将展示在置顶信息中）";

/**
 * /risk 确认（T37）：回 topic，携带目标用户 ID + 提醒一次性行为说明
 *（重新标记后下一条消息会再提醒一次）。
 */
export function formatRiskConfirmed(userId: number): string {
  return `已标记用户 ${userId} 为高危用户：其来信将在话题内醒目提醒（24 小时内不重复）。`;
}

/** /unrisk 确认（T37）：回 topic */
export function formatUnriskConfirmed(userId: number): string {
  return `已取消用户 ${userId} 的高危标记。`;
}

/**
 * 高危用户来信提醒（T37）：发到 topic 内的醒目提示（⚠️ 前后缀 + 展示名），
 * 24 小时窗口内仅一条；displayName 为用户昵称（置顶信息同款回退链产物）。
 * 中继 / 账本照常——提醒只是附着物，不影响主链。
 */
export function formatRiskTopicNotice(displayName: string): string {
  return `⚠️ 高危用户来信提醒 ⚠️\n${displayName} 已被标记为高危用户，请注意甄别、谨慎处理。`;
}

/**
 * /verifyon 确认（T31）：含「已验证记录不受影响」说明——重开后已验证
 *（且未过期）用户照常通行，绝不误重验。
 */
export function formatVerifyOnConfirmed(): string {
  return "人机验证已开启。此前已验证的用户不受影响，无需重新验证。";
}

/**
 * /verifyoff 确认（T31）：含验证记录保留、重新开启后按记录与有效期判定
 * 的说明——关闭只是「整门跳过」，不动任何验证记录。
 */
export function formatVerifyOffConfirmed(): string {
  return "人机验证已临时关闭：新消息不再要求验证。已验证记录全部保留，重新开启后按记录与有效期判定，已验证且未过期的用户无需重验。";
}

/**
 * /verifymode 确认（T32）：携带切换后的新模式；纯按钮附防护较弱说明
 *（bot 可直接调 API 点击）。
 */
export function formatVerifyModeConfirmed(mode: "math" | "button"): string {
  return mode === "math"
    ? "验证模式已切换为数学题。"
    : "验证模式已切换为纯按钮。注意：纯按钮模式防护较弱，bot 可直接调 API 点击，仅建议受信任场景使用。";
}

/**
 * 纯按钮模式题面（T32）：单按钮 + 引导文案（与数学题共用「为确认你是
 * 真人」句式，保持验证语义一致）。
 */
export function formatVerifyButtonQuestion(): string {
  return "为确认你是真人，请点击下方按钮确认你不是机器人。";
}

/** 纯按钮模式的唯一按钮文案（T32）：点击即提交答案 0 */
export const VERIFY_BUTTON_LABEL = "我不是机器人";

/* ------------------------------------------------------------------ */
/* 阶段 6：会话维护（T38 archive/deluser / T39 purgemsg / T40 wipe）文案  */
/* ------------------------------------------------------------------ */

/** /archive 软归档的 pre-close 确认：必须在 topic 关闭前送达 */
export const ARCHIVE_PREPARING_TEXT = "正在软归档此用户：验证状态将清除，用户与本话题历史、备注会保留。";

/** /archive 软归档后的用户提示；管理员主动操作，不占用户触发式提示频控 slot */
export const ARCHIVE_USER_NOTICE = "本次会话已结束。如需继续联系客服，请重新发送 /start。";
export const DELUSER_WARNING_TEXT = "⚠️ 物理删除确认\n将删除此用户的 Hodor 档案、绑定、账本，以及客服群话题和其中消息。Telegram 私聊窗口中的双方历史不会删除。此操作不可恢复，请在 60 秒内确认。";
export const DELUSER_CONFIRM_LABEL = "确认物理删除";
export const DELUSER_CANCEL_LABEL = "取消";
export const DELUSER_TOAST_EXPIRED = "确认已超时，请重新发起 /deluser。";
export const DELUSER_TOAST_CANCELLED = "已取消，未删除数据。";
export const DELUSER_TOAST_NOT_ADMIN = "该操作仅客服管理员可用。";
export const DELUSER_TOAST_DONE = "群内话题与 Hodor 数据已删除；私聊历史保留。";
export const DELUSER_TOAST_FAILED = "Telegram 未能删除话题，数据已保留。";
export const ARCHIVE_SUCCESS_TEXT = "用户已软归档：验证与待答题已清除，话题已关闭。用户、绑定、消息历史与备注均保留；用户重新联系后会自动恢复原话题，并在验证开启时重新验证。";
export const ARCHIVE_CLOSE_FAILED_TEXT = "归档未执行：Telegram 未能关闭话题，用户数据与验证状态未变。请检查权限后重试。";

/**
 * /purgemsg 确认（T39）：三态计数——不把未删除内容标为已清空（failed>0
 * 时明确「有内容未清空」）。gone = 已不存在（可能已被手工删，重推重跑
 * 的收敛类）；failed = 权限不足等其他 permanent。pinnedReset 标记信息卡
 * 是否成功重置（false → 注明下次消息自动补发，不虚报已重置）。
 */
export function formatPurgeConfirmed(counts: {
  deleted: number;
  gone: number;
  failed: number;
  pinnedReset: boolean;
}): string {
  const lines = [`本话题消息清理完成：已删除 ${counts.deleted} 条`];
  if (counts.gone > 0) lines.push(`${counts.gone} 条已不存在（可能此前已被删除）`);
  if (counts.failed > 0) {
    lines.push(`⚠️ ${counts.failed} 条删除失败（bot 可能缺少「删除消息」权限），这些内容未清空，可手动删除。`);
  }
  lines.push(
    counts.pinnedReset
      ? "用户信息已重新发送并置顶。"
      : "⚠️ 用户信息未能重新置顶，下次收到用户消息时会自动补发。",
  );
  return lines.join("\n");
}

/**
 * /wipealldata 第一步警告（T40）：明确不可恢复范围与保留项。60 秒内点击
 * 「确认清空」才执行；完成文案独立（编辑本消息）。
 */
export const WIPE_WARNING_TEXT = [
  "⚠️ 危险操作 ⚠️",
  "将删除客服群内全部话题及其中群内消息，并清空全部数据，不可恢复：",
  "- 全部用户档案与验证 / 封禁 / 备注状态",
  "- 全部用户 ↔ 话题绑定",
  "- 全部消息记录",
  "- 客服群内全部话题（General 除外）",
  "",
  "保留：验证开关与模式（settings）、幂等台账（processed_updates）、Bot 身份（bots）。双方私聊窗口消息不在删除范围。",
  "",
  "请在 60 秒内点击按钮确认或取消。",
].join("\n");

/** /wipealldata 确认按钮文案（T40）：callback_data 由 wipe.ts 组装（w:yes:<epoch>） */
export const WIPE_CONFIRM_LABEL = "⚠️ 确认清空（不可恢复）";

/** /wipealldata 取消按钮文案（T40） */
export const WIPE_CANCEL_LABEL = "取消";

/** /wipealldata 确认执行后的完成文案（尝试编辑原警告消息；话题已被删时 edit 失败 warn 吞） */
export const WIPE_DONE_TEXT =
  "已删除客服群内全部话题（General 除外）并清空全部用户、绑定与消息记录。验证开关与模式保留。用户再次私聊将全新建档。";

/** /wipealldata 话题删除部分失败：不清库，提示失败数并引导重试 */
export function formatWipeTopicsFailed(failed: number): string {
  return `${failed} 个话题删除失败，数据未清空。请检查 bot 权限后重新发起 /wipealldata 继续删除。`;
}

/** /wipealldata 完成提示（话题已删，警告消息不在——toast 是主要反馈） */
export const WIPE_TOAST_DONE = "全部话题与 Hodor 数据已删除；私聊历史保留。";

/** wipe 回调 toast：非管理员（T40 再次鉴权失败） */
export const WIPE_TOAST_NOT_ADMIN = "该操作仅客服管理员可用。";

/** wipe 回调 toast：超过 60 秒有效期 */
export const WIPE_TOAST_EXPIRED = "确认已超时（60 秒），本次操作已放弃。请重新发起 /wipealldata。";

/** wipe 回调 toast：取消 */
export const WIPE_TOAST_CANCELLED = "已取消，未清空任何数据。";

/** wipe 回调 toast：确认后开始执行 */
export const WIPE_TOAST_RUNNING = "已确认，正在清空…";
