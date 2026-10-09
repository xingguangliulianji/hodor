/**
 * 环境变量解析与密钥比较（纯函数，只收 Workers env 绑定，绝不读 process.env）。
 *
 * 契约见 .trellis/spec/backend/env-config.md：
 * - 选填变量运行时可能为 undefined（binding 缺席），消费方必须自行处理默认值
 * - MAX_ATTEMPTS 缺省 3（对齐 docs/guide/deploy.md 变量表）
 * - 管理密钥 / webhook secret 的比较必须常量时间，防时序侧信道
 */

/**
 * 解析 SUPPORT_CHAT_ID（客服超级群 chat_id）。
 *
 * 必须是 `-100` 开头的合法整数（超级群规范形态）；缺失 / 前缀不符 / 非整数 → null，
 * 由调用方决定如何失败（如 /health 自检项）。
 */
export function parseSupportChatId(env: Cloudflare.Env): number | null {
  const raw = env.SUPPORT_CHAT_ID?.trim();
  if (!raw || !raw.startsWith("-100")) return null;
  const id = Number(raw);
  // 前缀合法但仍需是安全整数（排除 "-100abc"、"-100.5" 等）
  if (!Number.isSafeInteger(id) || id >= 0) return null;
  return id;
}

/**
 * 解析 ADMIN_IDS：逗号分隔的 Telegram 用户 ID 列表。
 *
 * 空白容忍（逐 token trim）；非法 token（非纯数字 / 超出安全整数）跳过不致命；
 * 缺失 / 空 → []（= 无管理员，出站全部静默）。
 */
export function parseAdminIds(env: Cloudflare.Env): number[] {
  const raw = env.ADMIN_IDS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "" && /^\d+$/.test(token) && Number.isSafeInteger(Number(token)))
    .map((token) => Number(token));
}

/**
 * 解析 MAX_ATTEMPTS：同一条 update 处理失败的最大重试次数。
 *
 * 缺失 / 非法 / 非正整数 → 3（docs/guide/deploy.md 缺省值；不轻信输入）。
 */
export function parseMaxAttempts(env: Cloudflare.Env): number {
  const raw = env.MAX_ATTEMPTS?.trim();
  if (!raw) return 3;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 3;
}

/**
 * 解析 MAX_MESSAGES_PER_MINUTE：入站限频的每用户每分钟上限（T29 固定窗口）。
 *
 * 缺失 / 非法 / 非正整数 → 20（docs/guide/deploy.md 缺省值；与 parseMaxAttempts
 * 同款「先解析、不轻信输入」模式，超限文案里的数字即来源于此）。
 */
export function parseMaxMessagesPerMinute(env: Cloudflare.Env): number {
  const raw = env.MAX_MESSAGES_PER_MINUTE?.trim();
  if (!raw) return 20;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 20;
}

/**
 * 解析 VERIFY_TTL_HOURS：验证有效期（小时，T33）。
 *
 * 缺失 / 非法 / 负数 / 非整数 → 0 = 永久有效（docs/guide/deploy.md 变量表
 * 缺省值；变量已在 env.d.ts / deploy.md 声明，本函数只补运行时解析——
 * 与 parseMaxMessagesPerMinute 同款「先解析、不轻信输入」模式）。
 * 0 是合法值（永不重验），不与「非法回退 0」歧义：两者行为一致。
 */
export function parseVerifyTtlHours(env: Cloudflare.Env): number {
  const raw = env.VERIFY_TTL_HOURS?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * 解析 WELCOME_TEXT：自定义欢迎语文案（选填）。
 *
 * 缺失 / trim 后为空 → null（调用方兜底默认文案，见 src/copy.ts——
 * 本文件保持纯解析，不 import 文案模块）；否则把字面 `\n`（反斜杠 n
 * 序列——面板 / .dev.vars 单行输入的主流写法）替换为真实换行后返回，
 * 真实换行原样保留、不重复解释。
 */
export function parseWelcomeText(env: Cloudflare.Env): string | null {
  const raw = env.WELCOME_TEXT?.trim();
  if (!raw) return null;
  return raw.replace(/\\n/g, "\n");
}

/**
 * 常量时间字符串比较（用于 ADMIN_SECRET 路径段 / TELEGRAM_WEBHOOK_SECRET 头校验）。
 *
 * 先对两边各做 SHA-256（定长 32 字节摘要——比较时长与输入长度无关，不泄漏长度），
 * 再对摘要字节做定长逐位异或累计，任何一位不同即 false。
 */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  // 防御式：SHA-256 摘要恒为 32 字节，此分支正常永不命中
  if (digestA.byteLength !== digestB.byteLength) return false;
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}
