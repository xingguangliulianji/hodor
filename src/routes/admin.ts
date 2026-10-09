/**
 * 管理端点（T13 / T14 + T34 验收增量命令菜单）：GET /setwebhook/<ADMIN_SECRET>、
 * GET /deletewebhook/<ADMIN_SECRET>。
 *
 * 鉴权约定（docs/guide/architecture.md）：路径段密钥比较用常量时间
 * （timingSafeEqualStrings），所有失败（env 缺 secret / 密钥不正确）统一
 * 401 +「无效的管理密钥」，不区分原因——不给探测者任何存在性反馈。
 *
 * 错误回显：Telegram 调用失败（permanent / retryable）一律 502 + 已消毒概要
 * （分类层只回传方法名 / 状态 / 信封 description，绝不含 token）；
 * 管理端点是人看的，无重投递机制，retryable 附提示即可。
 *
 * 命令菜单（T34 验收增量，best-effort）：setwebhook 成功后把
 * ADMIN_COMMAND_MENU 注册到客服群 scope（setMyCommands）；deletewebhook
 * 对称清理（deleteMyCommands）。失败仅 warn + 回显注明，绝不影响
 * webhook 绑定结果；env 无 SUPPORT_CHAT_ID → 跳过注册。
 */
import { ADMIN_COMMAND_MENU } from "../copy";
import { parseSupportChatId, timingSafeEqualStrings } from "../env";
import { upsertBot } from "../store/bots";
import { createTelegramClient } from "../telegram/client";
import type { TelegramBotUser, TelegramClient, TelegramError } from "../telegram/types";

/** 统一 401 文案（JSON body，与架构文档「无效的管理密钥」一致） */
function unauthorized(): Response {
  return Response.json({ error: "无效的管理密钥" }, { status: 401 });
}

/** 鉴权：env 缺 ADMIN_SECRET 或比较不相等 → false（对外同一种 401） */
async function secretMatches(env: Cloudflare.Env, presented: string): Promise<boolean> {
  const expected = env.ADMIN_SECRET;
  if (typeof expected !== "string" || expected === "") return false;
  return timingSafeEqualStrings(presented, expected);
}

/** Telegram 调用失败 → 502（permanent / retryable 同码，body 携带 kind 提示） */
function telegramFailure(stage: string, error: TelegramError): Response {
  const detail = error.errorMessage ?? `${stage} 调用失败`;
  return Response.json(
    error.kind === "retryable"
      ? { status: "error", detail, retryable: true }
      : { status: "error", detail },
    { status: 502 },
  );
}

/** 只回传变量名、绝不回传值的 500（配置缺失快速失败，不带空凭据继续） */
function missingConfig(names: string[]): Response {
  return Response.json({ error: `配置缺失：${names.join("、")}` }, { status: 500 });
}

/** bots 行展示形状（getMe 子集；不含任何密钥） */
function botPayload(bot: TelegramBotUser) {
  return {
    id: bot.id,
    username: bot.username ?? "",
    display_name: bot.first_name ?? "",
  };
}

/**
 * GET /setwebhook/<ADMIN_SECRET>
 * 校验密钥 → setWebhook(origin+/webhook, secret_token, allowed_updates)
 * → getMe → upsertBot → 注册命令菜单（客服群 scope，best-effort）
 * → 回显 bot 身份与 webhook url（不回显任何密钥）。
 */
export async function handleSetWebhook(
  request: Request,
  env: Cloudflare.Env,
  secret: string,
): Promise<Response> {
  if (!(await secretMatches(env, secret))) return unauthorized();

  const missing: string[] = [];
  if (!env.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!env.TELEGRAM_WEBHOOK_SECRET) missing.push("TELEGRAM_WEBHOOK_SECRET");
  if (missing.length > 0) return missingConfig(missing);

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const webhookUrl = new URL(request.url).origin + "/webhook";

  const hook = await client.setWebhook({
    url: webhookUrl,
    secretToken: env.TELEGRAM_WEBHOOK_SECRET,
    // message 供阶段 2 双向中继；callback_query 供阶段 4 验证码回调，
    // 一次绑定性配齐，多余类型在 classify 安全忽略
    allowedUpdates: ["message", "callback_query"],
  });
  if (!hook.ok) return telegramFailure("setWebhook", hook);

  const me = await client.getMe();
  if (!me.ok) return telegramFailure("getMe", me);

  await upsertBot(env.HODOR_DB, {
    botId: me.result.id,
    username: me.result.username ?? "",
    displayName: me.result.first_name ?? "",
  });

  /* ---------------- 命令菜单注册（T34 验收增量，best-effort） ---------------- */
  const commands = await registerCommandMenu(client, env);

  return Response.json({
    status: "ok",
    bot: botPayload(me.result),
    webhook: { url: webhookUrl },
    commands,
  });
}

/**
 * 把 ADMIN_COMMAND_MENU 注册到客服群 scope。回显三态：
 * - "registered"：注册成功（客服群输入框可点选命令）；
 * - "skipped"：SUPPORT_CHAT_ID 无效（无从定位客服群，绝不落到全局 scope）；
 * - "failed:<已消毒摘要>"：注册失败——best-effort，不影响 webhook 绑定结果。
 */
async function registerCommandMenu(
  client: TelegramClient,
  env: Cloudflare.Env,
): Promise<string> {
  const supportChatId = parseSupportChatId(env);
  if (supportChatId === null) return "skipped";

  const menu = await client.setMyCommands({
    commands: [...ADMIN_COMMAND_MENU],
    // scope 限定客服群（type "chat"）：绝不污染用户私聊的命令菜单
    scope: { type: "chat", chat_id: supportChatId },
  });
  if (menu.ok) return "registered";

  console.warn(
    `[admin] setMyCommands 注册失败（不影响 webhook 绑定）：${menu.errorMessage ?? "no detail"}`,
  );
  return `failed:${menu.errorMessage ?? "no detail"}`;
}

/**
 * GET /deletewebhook/<ADMIN_SECRET>
 * 校验密钥 → deleteWebhook 解绑 → 清理命令菜单（同 scope，best-effort）
 * → 200 {"status":"ok"}。
 */
export async function handleDeleteWebhook(
  env: Cloudflare.Env,
  secret: string,
): Promise<Response> {
  if (!(await secretMatches(env, secret))) return unauthorized();

  if (!env.TELEGRAM_BOT_TOKEN) return missingConfig(["TELEGRAM_BOT_TOKEN"]);

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const result = await client.deleteWebhook();
  if (!result.ok) return telegramFailure("deleteWebhook", result);

  // 命令菜单对称清理（T34 验收增量，best-effort）：与注册同一 scope；
  // webhook 已解绑，菜单清理失败只影响点选体验——warn 即可，不改变 200
  const supportChatId = parseSupportChatId(env);
  if (supportChatId !== null) {
    const cleanup = await client.deleteMyCommands({
      scope: { type: "chat", chat_id: supportChatId },
    });
    if (!cleanup.ok) {
      console.warn(
        `[admin] deleteMyCommands 清理失败（best-effort）：${cleanup.errorMessage ?? "no detail"}`,
      );
    }
  }
  return Response.json({ status: "ok" });
}

/* ------------------------------------------------------------------ */
/* 路径解析：供 index.ts 极薄路由复用                                   */
/* ------------------------------------------------------------------ */

export type AdminAction = "setwebhook" | "deletewebhook";

/**
 * 从 pathname 提取管理动作与密钥段。
 *
 * 合法形态：恰好两段——`/<action>/<secret>`，secret 段非空。
 * 段数不足（缺密钥）/ 超出（多段）/ 前缀不符 / 畸形百分号编码 → null（index 层 404）。
 * 密钥段做一次 decodeURIComponent，浏览器对特殊字符的编码不影响比较。
 */
export function parseAdminPath(pathname: string): { action: AdminAction; secret: string } | null {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) return null;
  const [action, rawSecret] = segments as [string, string];
  if (action !== "setwebhook" && action !== "deletewebhook") return null;
  try {
    return { action, secret: decodeURIComponent(rawSecret) };
  } catch {
    // 畸形百分号编码：没有可用的密钥段，按路由不匹配处理
    return null;
  }
}
