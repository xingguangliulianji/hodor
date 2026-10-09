/**
 * GET /health — 轻量存活探针（零变化，字节级契约）。
 * 零外部依赖（不查 env / D1 / Telegram），供 uptime 监控高频访问；
 * version 由构建时从 package.json 注入（src/generated/version.ts，T08）。
 *
 * GET /selfcheck — 完整自检（T07，阶段 7）：按 env → 七表 → webhook 固定
 * 顺序逐项检查，三项独立执行（env 失败不阻断后续）；全过 200 ok，任何
 * 失败 503 + failed 文案数组（文案表见任务 design.md §1，本层只做装配，
 * 检查逻辑全在 src/selfcheck.ts）。缺 TELEGRAM_BOT_TOKEN 时不建 client、
 * 不发起 Telegram 调用；getWebhookInfo 单次消费，两种失败分类（retryable /
 * permanent）均落 failed、不重试。端点公开只读（无鉴权，用户决策）：失败
 * 文案只含变量名 / 表名 / 非密钥原值，绝不回显密钥值。
 */
import { VERSION } from "../generated/version";
import { checkEnv, checkTables, checkWebhook, isConfigured } from "../selfcheck";
import { createTelegramClient } from "../telegram/client";
import type { TelegramResult, WebhookInfo } from "../telegram/types";

export function handleHealth(): Response {
  return Response.json({ status: "ok", version: VERSION });
}

export async function handleSelfCheck(request: Request, env: Cloudflare.Env): Promise<Response> {
  // 固定顺序 env → 表 → webhook（failed 数组按此顺序汇总，三项互不阻断）
  const failed: string[] = [...checkEnv(env), ...(await checkTables(env.HODOR_DB))];

  // webhook 期望地址 = 本 Worker 的 /webhook（与 handleSetWebhook 的拼法一致）
  const expectedUrl = new URL(request.url).origin + "/webhook";

  // 缺 token → 不建 client、不发起 Telegram 调用（缺失已由 env 项点名，
  // checkWebhook 以 null 识别并给「无法检查」文案）
  let info: TelegramResult<WebhookInfo> | null = null;
  if (isConfigured(env.TELEGRAM_BOT_TOKEN)) {
    const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
    info = await client.getWebhookInfo();
  }
  failed.push(...checkWebhook(info, expectedUrl));

  return failed.length === 0
    ? Response.json({ status: "ok", version: VERSION })
    : Response.json({ status: "error", version: VERSION, failed }, { status: 503 });
}
