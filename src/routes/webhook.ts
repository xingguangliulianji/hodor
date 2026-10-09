/**
 * POST /webhook（T15 / T16 / T17 + T27 callback 派发）：Telegram update 唯一入口。
 *
 * 路由层保持极薄（架构分层约定）：只做「鉴权 → 解析 → 认领 → 分流 → 派发」的
 * 编排，业务全部在 pipeline，数据全部在 store，Telegram 调用全部在 client。
 * classify 分流：inbound / outbound / topic_event / private callback / group callback；
 * 所有类别同样携带 update_id——
 * 幂等认领 / 毒丸状态机与其余分流完全共用。
 *
 * | 环节 | 结果 | 响应 |
 * |------|------|------|
 * | 头缺失 / 不等于 TELEGRAM_WEBHOOK_SECRET | 401 统一文案，零 DB 写 | 401 |
 * | body 非 JSON / 无 update_id | 毒丸，不能让 Telegram 无限重推 | 200 |
 * | bots 表空（未 setwebhook） | 无法归属，日志定位 | 500 |
 * | claim = duplicate（processed/failed 重放） | 直接跳过 | 200 |
 * | claim = in-flight（并发在途） | Telegram 稍后重推接管 | 500 |
 * | claim = poison（attempts ≥ MAX_ATTEMPTS） | markFailed 跳过 | 200 |
 * | classify = ignore | 安全忽略 | markProcessed + 200 |
 * | pipeline 完成（含 permanent 静默吞） | 成功 | markProcessed + 200 |
 * | pipeline 抛出（retryable） | 保持 processing 等重推接管 | 500 |
 *
 * 日志纪律：只记 update_id / bot_id / chat id 与已消毒错误摘要，
 * 绝不输出 token / 任何 secret。
 */
import { parseMaxAttempts, parseSupportChatId, timingSafeEqualStrings } from "../env";
import { classifyUpdate, type TelegramCallbackQueryRef, type TelegramMessageRef } from "../pipeline/classify";
import { handleInbound } from "../pipeline/inbound";
import { handleOutbound } from "../pipeline/outbound";
import { handleVerifyCallback } from "../pipeline/verify";
import { handleWipeCallback } from "../pipeline/wipe";
import { handleTopicEvent } from "../pipeline/topicEvents";
import { handleDeluserCallback } from "../pipeline/deluser";
import { getSingleBotId } from "../store/bots";
import { claimUpdate, markFailed, markProcessed } from "../store/processedUpdates";

/** Telegram 只看状态码的 200（body 保持极简） */
function ok(): Response {
  return Response.json({ status: "ok" });
}

/** 统一 401（头缺失 / env 缺 secret / 比较不相等，对外零区分信息） */
function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/** 临时性失败（重推 / 配置自愈后可恢复），body 不携带任何细节 */
function temporaryFailure(): Response {
  return Response.json({ error: "temporary_failure" }, { status: 500 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function handleWebhook(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  /* ---------------- ① 头鉴权：统一 401，之前零 DB 写 ---------------- */
  const presented = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  const authorized =
    presented !== "" &&
    typeof expected === "string" &&
    expected !== "" &&
    (await timingSafeEqualStrings(presented, expected));
  if (!authorized) return unauthorized();

  /* ---------------- ② 解析：不可解析 = 毒丸 200（重推无意义） ---------------- */
  let update: unknown;
  try {
    update = await request.json();
  } catch {
    console.warn("[webhook] body 非 JSON，按毒丸 200 丢弃");
    return ok();
  }
  if (!isRecord(update) || typeof update.update_id !== "number") {
    console.warn("[webhook] body 缺合法 update_id，按毒丸 200 丢弃");
    return ok();
  }
  const updateId = update.update_id;

  /* ---------------- ③ 归属：bot 身份来自 bots 表（未绑定 → 500 重推无害） ---------------- */
  const botId = await getSingleBotId(env.HODOR_DB);
  if (botId === null) {
    console.warn(`[webhook] update ${updateId}: bots 表为空（尚未 setwebhook）→ 500`);
    return temporaryFailure();
  }

  /* ---------------- ④ 幂等认领（processed_updates 状态机） ---------------- */
  const claim = await claimUpdate(env.HODOR_DB, {
    botId,
    updateId,
    maxAttempts: parseMaxAttempts(env),
  });
  if (claim.decision === "duplicate") return ok();
  if (claim.decision === "in-flight") {
    // 并发同 id 在途：500 让 Telegram 稍后重推（原处理完成 → duplicate；
    // 原处理崩溃 → 过期接管），两种情况都不丢不重
    console.warn(`[webhook] update ${updateId}: 在途认领未过期 → 500 交由重推`);
    return temporaryFailure();
  }
  if (claim.decision === "poison") {
    await markFailed(env.HODOR_DB, botId, updateId);
    console.warn(
      `[webhook] update ${updateId}: attempts=${claim.attempts} 达上限 → 毒丸跳过`,
    );
    return ok();
  }

  /* ---------------- ⑤ 按分类派发（classify fail-closed：env 畸形时全 ignore） ---------------- */
  const kind = classifyUpdate(update, parseSupportChatId(env));
  if (kind === "ignore") {
    await markProcessed(env.HODOR_DB, botId, updateId);
    return ok();
  }

  // classify 已做运行时形态校验；此处仅收窄类型（缺字段 = 不可达的防御式兜底，
  // warn 后按毒丸 200 处理，不让畸形信封触发重推）
  try {
    if (kind === "topic_event") {
      const message = update.message as TelegramMessageRef | undefined;
      if (message) await handleTopicEvent(env.HODOR_DB, botId, message);
    } else if (kind === "callback" || kind === "group_callback") {
      // callback = 私聊题面按钮（T27）；group_callback = 客服群内按钮
      //（T40 wipe 确认键盘）——两者信封同形，仅 chat 归属不同
      const callbackQuery = update.callback_query as TelegramCallbackQueryRef | undefined;
      if (callbackQuery) {
        if (kind === "callback") {
          await handleVerifyCallback(env, botId, callbackQuery);
        } else {
          if (callbackQuery.data?.startsWith("d:")) {
            await handleDeluserCallback(env, botId, callbackQuery);
          } else {
            await handleWipeCallback(env, botId, callbackQuery);
          }
        }
      } else {
        console.warn(`[webhook] update ${updateId}: classify=${kind} 但 callback_query 缺失`);
      }
    } else {
      const message = update.message as TelegramMessageRef | undefined;
      if (!message) {
        console.warn(`[webhook] update ${updateId}: classify=${kind} 但 message 缺失`);
      } else if (kind === "inbound") {
        await handleInbound(env, botId, message);
      } else {
        await handleOutbound(env, botId, message);
      }
    }
  } catch (error) {
    // retryable：保持 processing 返回 500，交由 Telegram 重推 + 状态机接管。
    // 部分成功窗口（design.md 已知代价）：若失败前 sendMessage 实际已送达，
    // 60s 过期接管后会重发一次——at-least-once 的代价，绝不提前标记
    // processed 掩盖失败而丢消息（p1.md 警示；行为由
    // test/webhook-route.test.ts「部分成功窗口」用例固化）。callback 分支
    // 同理：答题链 retryable 抛出 → 重推收敛到「题目已失效」分支（幂等）。
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[webhook] update ${updateId} (${kind}) 处理失败，等待重推：${detail}`);
    return temporaryFailure();
  }
  await markProcessed(env.HODOR_DB, botId, updateId);
  return ok();
}
