/**
 * 管理端点集成（T13/T14 + T34 验收增量命令菜单）：路径段鉴权统一 401、
 * setwebhook 全链路（出站 payload / bots upsert / 响应形状 / 密钥零泄漏 /
 * 命令菜单注册 registered-skipped-failed 三态与 scope 断言）、deletewebhook
 * （解绑 + 菜单对称清理 best-effort）、Telegram 失败映射 502。
 * webhook 行为见 test/webhook-route.test.ts。
 *
 * 经 SELF.fetch 走完整 worker 入口；出站请求经 telegramFetchStub 拦截
 * （main worker 与测试同 isolate，全局 fetch 替换对其生效），无真实网络。
 * 环境变量来自 vitest.config.ts 注入的确定性 bindings。
 */
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_COMMAND_MENU } from "../src/copy";
import { handleSetWebhook } from "../src/routes/admin";
import {
  stubTelegramFetch,
  type TelegramFetchStub,
} from "./helpers/telegramFetchStub";

const ADMIN_SECRET = env.ADMIN_SECRET; // 'test-admin-secret'（vitest.config.ts）
const WEBHOOK_SECRET = env.TELEGRAM_WEBHOOK_SECRET; // 'test-webhook-secret'
const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN; // 'test-bot-token'
const SUPPORT_CHAT_ID = -1001234567890; // vitest.config.ts 注入值

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
});

describe("GET /setwebhook/<ADMIN_SECRET>", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("正确密钥：setWebhook + getMe + setMyCommands 各恰一次 → 200 回显身份与 webhook url，bots 落行，无任何密钥泄漏", async () => {
    stub.always("setWebhook", { status: 200, json: { ok: true, result: true } });
    stub.always("getMe", {
      status: 200,
      json: { ok: true, result: { id: 42, is_bot: true, username: "hodor_bot", first_name: "hodor" } },
    });
    stub.always("setMyCommands", { status: 200, json: { ok: true, result: true } });

    const res = await SELF.fetch(`https://example.com/setwebhook/${ADMIN_SECRET}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: "ok",
      bot: { id: 42, username: "hodor_bot", display_name: "hodor" },
      webhook: { url: "https://example.com/webhook" },
      commands: "registered",
    });

    // Telegram 恰好各调用一次
    expect(stub.countOf("setWebhook")).toBe(1);
    expect(stub.countOf("getMe")).toBe(1);
    expect(stub.countOf("setMyCommands")).toBe(1);
    // T13：url=origin+/webhook；注册 secret_token；allowed_updates 一次配齐
    expect(stub.callsOf("setWebhook")[0].body).toEqual({
      url: "https://example.com/webhook",
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    });
    // T34 验收增量：命令清单 = copy 单点；scope 限定客服群（type "chat"），
    // 绝不污染用户私聊菜单；命令体无斜杠小写
    expect(stub.callsOf("setMyCommands")[0].body).toEqual({
      commands: ADMIN_COMMAND_MENU.map((c) => ({ ...c })),
      scope: { type: "chat", chat_id: SUPPORT_CHAT_ID },
    });
    // bots 行 upsert
    const bot = await env.HODOR_DB.prepare(
      "SELECT bot_id, username, display_name FROM bots",
    ).first<{ bot_id: number; username: string; display_name: string }>();
    expect(bot).toEqual({ bot_id: 42, username: "hodor_bot", display_name: "hodor" });
    // 响应体零密钥
    const text = JSON.stringify(body);
    expect(text).not.toContain(ADMIN_SECRET);
    expect(text).not.toContain(WEBHOOK_SECRET);
    expect(text).not.toContain(BOT_TOKEN);
  });

  it("命令菜单注册失败（503 retryable）→ best-effort 降级：webhook 绑定照常 200，commands=failed:<已消毒摘要>，无密钥", async () => {
    stub.always("setWebhook", { status: 200, json: { ok: true, result: true } });
    stub.always("getMe", {
      status: 200,
      json: { ok: true, result: { id: 42, is_bot: true, username: "hodor_bot", first_name: "hodor" } },
    });
    stub.always("setMyCommands", { status: 503, json: { ok: false, description: "upstream boom" } });

    const res = await SELF.fetch(`https://example.com/setwebhook/${ADMIN_SECRET}`);
    expect(res.status).toBe(200); // 菜单失败不影响绑定结果
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(String(body.commands)).toMatch(/^failed:/);
    expect(String(body.commands)).toContain("setMyCommands"); // 已消毒摘要（方法名 + 状态）
    expect(JSON.stringify(body)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(body)).not.toContain(ADMIN_SECRET);
  });

  it("SUPPORT_CHAT_ID 无效 → 菜单注册跳过：commands=skipped、零 setMyCommands 调用（handler 直调：SELF bindings 固定）", async () => {
    stub.always("setWebhook", { status: 200, json: { ok: true, result: true } });
    stub.always("getMe", {
      status: 200,
      json: { ok: true, result: { id: 42, is_bot: true, username: "hodor_bot", first_name: "hodor" } },
    });
    // 无从定位客服群：绝不落到全局 scope（宁可跳过）
    const partialEnv = {
      HODOR_DB: env.HODOR_DB,
      ADMIN_SECRET,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    } as unknown as Cloudflare.Env;
    const request = new Request(`https://example.com/setwebhook/${ADMIN_SECRET}`);

    const res = await handleSetWebhook(request, partialEnv, ADMIN_SECRET);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", commands: "skipped" });
    expect(stub.countOf("setMyCommands")).toBe(0);
  });

  it("错误密钥 → 401 统一文案，且不触发任何 Telegram 出站调用", async () => {
    stub.always("getMe", { status: 200, json: { ok: true, result: { id: 1 } } });
    const res = await SELF.fetch("https://example.com/setwebhook/wrong-secret");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "无效的管理密钥" });
    expect(stub.countOf("setWebhook")).toBe(0);
    expect(stub.countOf("getMe")).toBe(0);
  });

  it("env 缺 ADMIN_SECRET → 与错误密钥完全同一的 401（handler 直调：SELF bindings 固定）", async () => {
    // 直调 handler（SELF.fetch 的 bindings 不可改）：呈现的密钥值本身合法，
    // 但 env 无期望值 → 必须 401，且 body 与错误密钥逐字一致（对外零区分）
    const partialEnv = {
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    } as unknown as Cloudflare.Env;
    const request = new Request(`https://example.com/setwebhook/${ADMIN_SECRET}`);

    const missing = await handleSetWebhook(request, partialEnv, ADMIN_SECRET);
    expect(missing.status).toBe(401);
    const missingBody = await missing.json();
    expect(missingBody).toEqual({ error: "无效的管理密钥" });

    const wrong = await SELF.fetch("https://example.com/setwebhook/wrong-secret");
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual(missingBody);
    expect(stub.countOf("setWebhook")).toBe(0);
  });

  it("路径段畸形（缺段 / 多段 / 缺前缀）→ 404", async () => {
    for (const path of [
      "/setwebhook/", // 缺密钥段
      "/setwebhook", // 无斜杠
      "/setwebhook/a/b", // 多段
      "/deletewebhook/", //
      "/deletewebhook/a/b",
      "/setwebhookx/abc", // 前缀不符（防前缀碰撞）
    ]) {
      const res = await SELF.fetch(`https://example.com${path}`);
      expect(res.status, path).toBe(404);
    }
    expect(stub.countOf("setWebhook")).toBe(0);
  });

  it("getMe permanent（200+ok:false）→ 502，bots 不落行，body 无密钥", async () => {
    stub.always("setWebhook", { status: 200, json: { ok: true, result: true } });
    stub.always("getMe", {
      status: 200,
      json: { ok: false, error_code: 400, description: "Bad Request: invalid token" },
    });
    // getMe 失败 → 不落任何新 bots 行（按前后行数断言，不依赖同文件其他用例）
    const botsCount = async () =>
      (
        await env.HODOR_DB.prepare("SELECT COUNT(*) AS n FROM bots").first<{ n: number }>()
      )?.n ?? 0;
    const before = await botsCount();
    const res = await SELF.fetch(`https://example.com/setwebhook/${ADMIN_SECRET}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("error");
    expect(String(body.detail)).toContain("Bad Request: invalid token");
    expect(body.retryable).toBeUndefined();
    expect(await botsCount()).toBe(before);
    const text = JSON.stringify(body);
    expect(text).not.toContain(BOT_TOKEN);
    expect(text).not.toContain(ADMIN_SECRET);
  });

  it("setWebhook retryable（5xx）→ 502 且带 retryable 提示，getMe 不被调用", async () => {
    stub.always("setWebhook", { status: 500, json: { ok: false, description: "Internal Server Error" } });
    stub.always("getMe", { status: 200, json: { ok: true, result: { id: 1 } } });
    const res = await SELF.fetch(`https://example.com/setwebhook/${ADMIN_SECRET}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "error", retryable: true });
    expect(stub.countOf("getMe")).toBe(0);
    expect(JSON.stringify(body)).not.toContain(BOT_TOKEN);
  });

  it("配置缺失（TELEGRAM_BOT_TOKEN 未设置）→ 500 只报变量名，绝不报值", async () => {
    // SELF 的 bindings 固定，缺失分支直测 handler（鉴权用真实 ADMIN_SECRET）
    const partialEnv = {
      ADMIN_SECRET,
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    } as unknown as Cloudflare.Env;
    const request = new Request(`https://example.com/setwebhook/${ADMIN_SECRET}`);
    const res = await handleSetWebhook(request, partialEnv, ADMIN_SECRET);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain("TELEGRAM_BOT_TOKEN");
    expect(String(body.error)).not.toContain(BOT_TOKEN);
    expect(String(body.error)).not.toContain(WEBHOOK_SECRET);
    expect(stub.countOf("setWebhook")).toBe(0);
  });
});

describe("GET /deletewebhook/<ADMIN_SECRET>", () => {
  let stub: TelegramFetchStub;
  beforeEach(() => {
    stub = stubTelegramFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("正确密钥 → deleteWebhook + deleteMyCommands（同 scope 对称清理）各恰一次 → 200 {\"status\":\"ok\"}", async () => {
    stub.always("deleteWebhook", { status: 200, json: { ok: true, result: true } });
    stub.always("deleteMyCommands", { status: 200, json: { ok: true, result: true } });
    const res = await SELF.fetch(`https://example.com/deletewebhook/${ADMIN_SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(stub.countOf("deleteWebhook")).toBe(1);
    // 清理与注册同一 scope（客服群 chat）——留全局菜单与否不属本端点职责
    expect(stub.countOf("deleteMyCommands")).toBe(1);
    expect(stub.callsOf("deleteMyCommands")[0].body).toEqual({
      scope: { type: "chat", chat_id: SUPPORT_CHAT_ID },
    });
  });

  it("菜单清理失败（400 permanent）→ best-effort：仍 200 {\"status\":\"ok\"}（webhook 已解绑，菜单残留只影响点选）", async () => {
    stub.always("deleteWebhook", { status: 200, json: { ok: true, result: true } });
    stub.always("deleteMyCommands", {
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request" },
    });
    const res = await SELF.fetch(`https://example.com/deletewebhook/${ADMIN_SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(stub.countOf("deleteMyCommands")).toBe(1);
  });

  it("错误密钥 → 401 统一文案，不触发 Telegram 调用", async () => {
    stub.always("deleteWebhook", { status: 200, json: { ok: true, result: true } });
    const res = await SELF.fetch("https://example.com/deletewebhook/nope");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "无效的管理密钥" });
    expect(stub.countOf("deleteWebhook")).toBe(0);
  });

  it("Telegram 失败（permanent 400）→ 502，detail 含已消毒描述", async () => {
    stub.always("deleteWebhook", {
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request" },
    });
    const res = await SELF.fetch(`https://example.com/deletewebhook/${ADMIN_SECRET}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("error");
    expect(JSON.stringify(body)).not.toContain(BOT_TOKEN);
  });
});
