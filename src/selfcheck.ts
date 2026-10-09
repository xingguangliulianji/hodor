/**
 * /selfcheck 完整自检的纯检查函数集（T07，阶段 7；失败文案表逐字对齐任务
 * design.md §1——文案即对外契约）。三个函数各自只返回 failed 文案数组
 * （空数组 = 通过），本身不发请求、不写库：
 * - checkEnv：环境变量存在性 / 格式 / 互异 / 选填值域（纯本地计算）
 * - checkTables：一次 sqlite_master 查询比对七表期望集
 * - checkWebhook：消费 getWebhookInfo 结果（null = 缺 token，未发起调用）
 *
 * 与 src/env.ts 的分工（design.md 定稿，不抽公共函数强行统一）：env.ts 的
 * 解析是「容错解析（运行）」——非法值静默回退默认值，保证管线活着；本文件
 * 是「严格校验（诊断）」——非法值逐条点名，保证部署者能定位。ADMIN_IDS
 * 复用同一合法性判定（纯数字 + 安全整数）但独立实现严格报错。
 *
 * 安全不变量：任何文案只含变量名、表名、非密钥原值（webhook URL、
 * Telegram 投递错误原文）与 client 已消毒的错误概要，绝不回显密钥值。
 */
import { parseSupportChatId } from "./env";
import type { TelegramResult, WebhookInfo } from "./telegram/types";

/** 当前 schema 的全部业务表（0001 六表 + 0004 delete_confirmations），与 migrations 目录同评审 */
const EXPECTED_TABLES = [
  "users",
  "topics",
  "messages",
  "settings",
  "processed_updates",
  "bots",
  "delete_confirmations",
] as const;

/** 五条必填变量（数组顺序 = 缺失点名顺序） */
const REQUIRED_VARS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "ADMIN_SECRET",
  "SUPPORT_CHAT_ID",
  "ADMIN_IDS",
] as const;

/** 三个 Secret 的两两组合（顺序固定 = 文案「A 与 B」的呈现顺序） */
const SECRET_PAIRS = [
  ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"],
  ["TELEGRAM_BOT_TOKEN", "ADMIN_SECRET"],
  ["TELEGRAM_WEBHOOK_SECRET", "ADMIN_SECRET"],
] as const;

/** 「已配置」= binding 存在且 trim 后非空（空串视同未配置，与运行时解析的缺省分支一致）；
 *  兼作类型谓词，让选填变量的「已配置」分支收窄回 string */
export function isConfigured(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/** 与 parseAdminIds 同一合法性判定：纯数字且在安全整数范围内 */
function isValidUserIdToken(token: string): boolean {
  return /^\d+$/.test(token) && Number.isSafeInteger(Number(token));
}

/** 与 parseMaxAttempts / parseMaxMessagesPerMinute 的「合法」判定一致：安全正整数 */
function isPositiveInteger(raw: string): boolean {
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0;
}

/** 与 parseVerifyTtlHours 的「合法」判定一致：安全非负整数（0 = 永久是合法值） */
function isNonNegativeInteger(raw: string): boolean {
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * ADMIN_IDS 严格校验（诊断专用；parseAdminIds 的静默跳过是运行契约，不动）。
 * - 一个合法 ID 都解析不出 → 整体非法（运行时「无管理员、出站全静默」）；
 * - 含非空非法 token → 逐个按位置（第 N 个，从 1 起）点名；
 *   空 token 容忍（尾逗号等），与 parseAdminIds 的跳过语义对齐。
 */
function checkAdminIds(raw: string): string[] {
  const tokens = raw.split(",").map((token) => token.trim());
  if (!tokens.some((token) => isValidUserIdToken(token))) {
    return ["ADMIN_IDS 非法：未解析出任何合法用户 ID"];
  }
  return tokens
    .flatMap((token, index) => (token !== "" && !isValidUserIdToken(token) ? [index + 1] : []))
    .map((position) => `ADMIN_IDS 含无法解析的项（第 ${position} 个）`);
}

/**
 * 环境变量检查（纯本地计算，零外部调用）。
 * 返回按固定顺序汇总：必填存在 → SUPPORT_CHAT_ID 格式 → ADMIN_IDS 严格解析
 * → 三个 Secret 互异 → 选填值域。已由存在性点名的变量不再重复报格式。
 */
export function checkEnv(env: Cloudflare.Env): string[] {
  const failed: string[] = [];

  // 必填存在性：缺失逐个点名，合并为一条（部署者一次看全该配哪些）
  const missing = REQUIRED_VARS.filter((name) => !isConfigured(env[name]));
  if (missing.length > 0) {
    failed.push(`必填变量未配置：${missing.join("、")}`);
  }

  // SUPPORT_CHAT_ID 格式：直接复用 parseSupportChatId（语义天然对齐）
  if (isConfigured(env.SUPPORT_CHAT_ID) && parseSupportChatId(env) === null) {
    failed.push("SUPPORT_CHAT_ID 非法：应为 -100 开头的整数");
  }

  // ADMIN_IDS 严格解析（见 checkAdminIds 注释）
  if (isConfigured(env.ADMIN_IDS)) {
    failed.push(...checkAdminIds(env.ADMIN_IDS));
  }

  // 三个 Secret 互异：只在双方都已配置时比较（缺失已由存在性点名；
  // 相同的密钥会让某条鉴权形同虚设，必须在部署期暴露）
  for (const [a, b] of SECRET_PAIRS) {
    if (isConfigured(env[a]) && isConfigured(env[b]) && env[a] === env[b]) {
      failed.push(`密钥变量取值重复：${a} 与 ${b} 相同（三者必须互异）`);
    }
  }

  // 选填值域：已配置但非法 → 点名 + 运行时实际会回退到的默认值（对齐 env.ts）
  if (isConfigured(env.MAX_ATTEMPTS) && !isPositiveInteger(env.MAX_ATTEMPTS)) {
    failed.push("MAX_ATTEMPTS 已配置但非法（正整数），运行时将回退默认 3");
  }
  if (
    isConfigured(env.MAX_MESSAGES_PER_MINUTE) &&
    !isPositiveInteger(env.MAX_MESSAGES_PER_MINUTE)
  ) {
    failed.push("MAX_MESSAGES_PER_MINUTE 已配置但非法（正整数），运行时将回退默认 20");
  }
  if (isConfigured(env.VERIFY_TTL_HOURS) && !isNonNegativeInteger(env.VERIFY_TTL_HOURS)) {
    failed.push("VERIFY_TTL_HOURS 已配置但非法（非负整数），运行时将回退默认 0");
  }

  return failed;
}

/**
 * 数据库检查：一次 sqlite_master 全表查询，与七表期望集比对。
 * 查询抛错（HODOR_DB 绑定不可用 / D1 故障）→ 单条「不可用」；缺表按
 * EXPECTED_TABLES 顺序逐张列出。sqlite 内部表（sqlite_% / _cf_METADATA /
 * d1_migrations）无需排除——只判期望表的存在性，多余表与自检无关。
 */
export async function checkTables(db: D1Database): Promise<string[]> {
  let rows: { name: string }[];
  try {
    const query = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>();
    rows = query.results;
  } catch {
    return ["数据库不可用：HODOR_DB 绑定查询失败"];
  }
  const present = new Set(rows.map((row) => row.name));
  return EXPECTED_TABLES.filter((table) => !present.has(table)).map(
    (table) => `数据库缺表：${table}（迁移可能未执行，请在构建日志确认 migrations 步骤）`,
  );
}

/**
 * Webhook 绑定检查（纯函数，不发请求——调用方先单次 getWebhookInfo 再传入）。
 * info 为 null 表示缺 TELEGRAM_BOT_TOKEN（调用方未建 client）；失败概要用
 * client 已消毒的 errorMessage（只含方法名 / 状态 / 信封 description，绝不
 * 含 token）。绑定错址与 last_error_message 可并列出现（两条独立诊断）。
 */
export function checkWebhook(
  info: TelegramResult<WebhookInfo> | null,
  expectedUrl: string,
): string[] {
  if (info === null) {
    return ["无法检查 Webhook：TELEGRAM_BOT_TOKEN 未配置"];
  }
  if (!info.ok) {
    return [`Webhook 状态未知：getWebhookInfo 调用失败（${info.errorMessage ?? "无错误详情"}）`];
  }
  const failed: string[] = [];
  if (info.result.url === "") {
    failed.push("webhook 未绑定，请访问 /setwebhook/<ADMIN_SECRET> 完成绑定");
  } else if (info.result.url !== expectedUrl) {
    failed.push(
      `webhook 指向错误地址：${info.result.url}（应为 ${expectedUrl}，请重新执行 /setwebhook）`,
    );
  }
  // Telegram 记录的最近投递错误原文：非密钥、本身就是排障信息，直接回显
  if (info.result.last_error_message) {
    failed.push(`Telegram 最近投递错误：${info.result.last_error_message}`);
  }
  return failed;
}
