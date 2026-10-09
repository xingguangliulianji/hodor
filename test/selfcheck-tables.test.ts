/**
 * GET /selfcheck 数据库检查（T07，阶段 7）——缺表 / 齐全两种 D1 状态。
 *
 * 利用「每测试文件隔离 D1」的基座约定：本文件刻意不在 beforeAll 应用迁移，
 * 先断言全库空表状态下 selfcheck 逐张点名缺表；再在文件内 applyD1Migrations
 * 后复测通过（先后两种状态各断言一次——两条用例有顺序依赖，vitest 按声明
 * 顺序串行执行）。env 项全过（vitest 钉死值全合法），webhook 项经桩返回
 * 正确地址正常通过，使 failed 恰好只反映表状态。
 *
 * 「数据库不可用」分支用构造 env 直调 handleSelfCheck + prepare 即抛错的
 * 假 D1 绑定覆盖（checkTables 的唯一依赖是 prepare().all()）。
 */
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/generated/version";
import { handleSelfCheck } from "../src/routes/health";
import { stubTelegramFetch, type TelegramFetchStub } from "./helpers/telegramFetchStub";

let stub: TelegramFetchStub;

beforeEach(() => {
  stub = stubTelegramFetch();
  stub.always("getWebhookInfo", { json: { ok: true, result: { url: "https://example.com/webhook" } } });
});

afterEach(() => {
  stub.restore();
});

describe("/selfcheck 数据库检查", () => {
  it("未应用迁移 → 503，failed 按期望表顺序逐张点名缺表", async () => {
    const res = await SELF.fetch("https://example.com/selfcheck");
    expect(res.status).toBe(503);
    expect(JSON.parse(await res.text())).toEqual({
      status: "error",
      version: VERSION,
      failed: [
        "数据库缺表：users（迁移可能未执行，请在构建日志确认 migrations 步骤）",
        "数据库缺表：topics（迁移可能未执行，请在构建日志确认 migrations 步骤）",
        "数据库缺表：messages（迁移可能未执行，请在构建日志确认 migrations 步骤）",
        "数据库缺表：settings（迁移可能未执行，请在构建日志确认 migrations 步骤）",
        "数据库缺表：processed_updates（迁移可能未执行，请在构建日志确认 migrations 步骤）",
        "数据库缺表：bots（迁移可能未执行，请在构建日志确认 migrations 步骤）",
        "数据库缺表：delete_confirmations（迁移可能未执行，请在构建日志确认 migrations 步骤）",
      ],
    });
  });

  it("应用迁移后复测 → 200 ok（七表齐全，三项全过）", async () => {
    await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
    const res = await SELF.fetch("https://example.com/selfcheck");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ status: "ok", version: VERSION }));
  });

  it("HODOR_DB 查询抛错 → 数据库不可用（绑定故障分支）", async () => {
    // 构造 prepare 即抛错的假绑定；env 其余项用钉死的全合法值
    const brokenDb = {
      prepare() {
        throw new Error("simulated D1 outage");
      },
    } as unknown as D1Database;
    const testEnv = {
      HODOR_DB: brokenDb,
      TELEGRAM_BOT_TOKEN: "test-bot-token",
      TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
      ADMIN_SECRET: "test-admin-secret",
      SUPPORT_CHAT_ID: "-1001234567890",
      ADMIN_IDS: "111111111,222222222",
    } as unknown as Cloudflare.Env;
    const res = await handleSelfCheck(new Request("https://example.com/selfcheck"), testEnv);
    expect(res.status).toBe(503);
    expect(JSON.parse(await res.text())).toEqual({
      status: "error",
      version: VERSION,
      failed: ["数据库不可用：HODOR_DB 绑定查询失败"],
    });
  });
});
