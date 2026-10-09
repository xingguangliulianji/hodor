/**
 * GET /selfcheck 完整自检（T07，阶段 7）——env 项与 webhook 项的分域用例。
 *
 * 全过路径经 SELF.fetch 走完整 worker 入口（vitest 钉死的 env 全合法 +
 * 已迁移 D1 + 桩返回指向正确地址的 webhook）；逐项破坏用例按 env.test.ts
 * 先例「构造 env 对象直调 handleSelfCheck」——钉死值只服务 SELF.fetch 路径，
 * 破坏分支必须构造覆盖。Telegram 出站全部经 telegramFetchStub 拦截：
 * 「缺 token 不发调用」用未注册 responder 的桩验证（若被调用会抛错，被
 * attempt() 捕获为 network error，failed 文案随之变成「状态未知」而露馅）。
 * 每条破坏用例附带「响应文本不含任何密钥值」断言（安全不变量）。
 * 缺表场景在 selfcheck-tables.test.ts 独立文件（不应用迁移的 D1 状态）。
 */
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/generated/version";
import { handleSelfCheck } from "../src/routes/health";
import { stubTelegramFetch, type TelegramFetchStub } from "./helpers/telegramFetchStub";

const SELF_URL = "https://example.com/selfcheck";
const EXPECTED_WEBHOOK_URL = "https://example.com/webhook";
/** 三个密钥的测试值（vitest.config 钉死）——破坏用例断言它们绝不出现在响应里 */
const SECRET_VALUES = ["test-bot-token", "test-webhook-secret", "test-admin-secret"];

beforeAll(async () => {
  // 本文件聚焦 env / webhook 两项；表检查走已迁移 D1（缺表场景独立文件覆盖）
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
});

let stub: TelegramFetchStub;

beforeEach(() => {
  stub = stubTelegramFetch();
});

afterEach(() => {
  stub.restore();
});

/** 构造 env（默认 = vitest 钉死的全合法值 + 已迁移 D1），覆盖项模拟配置破坏 */
function envWith(overrides: Record<string, string | undefined>): Cloudflare.Env {
  return {
    HODOR_DB: env.HODOR_DB,
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    ADMIN_SECRET: "test-admin-secret",
    SUPPORT_CHAT_ID: "-1001234567890",
    ADMIN_IDS: "111111111,222222222",
    MAX_ATTEMPTS: "3",
    MAX_MESSAGES_PER_MINUTE: "20",
    VERIFY_TTL_HOURS: "0",
    ...overrides,
  } as Cloudflare.Env;
}

/** 直调 handleSelfCheck 并断言 503 + 响应对象精确相等 + 无任何密钥值泄漏 */
async function expectFailed(
  envOverrides: Record<string, string | undefined>,
  expectedFailed: string[],
): Promise<void> {
  const res = await handleSelfCheck(new Request(SELF_URL), envWith(envOverrides));
  expect(res.status).toBe(503);
  const text = await res.text();
  for (const secret of SECRET_VALUES) {
    expect(text).not.toContain(secret);
  }
  expect(JSON.parse(text)).toEqual({ status: "error", version: VERSION, failed: expectedFailed });
}

/** 默认桩：getWebhookInfo 返回指向正确地址的绑定（webhook 项通过） */
function stubWebhookOk(url: string = EXPECTED_WEBHOOK_URL): void {
  stub.always("getWebhookInfo", { json: { ok: true, result: { url } } });
}

describe("GET /selfcheck 全过路径（SELF.fetch 完整入口）", () => {
  it("三项全过 → 200，body 严格等于 {\"status\":\"ok\",\"version\":…}", async () => {
    stubWebhookOk();
    const res = await SELF.fetch(SELF_URL);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ status: "ok", version: VERSION }));
    expect(stub.countOf("getWebhookInfo")).toBe(1);
  });

  it("POST /selfcheck → 404（仅接受 GET）", async () => {
    const res = await SELF.fetch(SELF_URL, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("环境变量检查（构造 env 直调）", () => {
  it("缺各必填变量（逐个）→ 合并一条逐个点名", async () => {
    stubWebhookOk();
    const required = [
      "TELEGRAM_WEBHOOK_SECRET",
      "ADMIN_SECRET",
      "SUPPORT_CHAT_ID",
      "ADMIN_IDS",
    ];
    for (const name of required) {
      await expectFailed({ [name]: undefined }, [`必填变量未配置：${name}`]);
    }
  });

  it("缺 TELEGRAM_BOT_TOKEN → 存在性 + webhook 双报，且零 Telegram 调用", async () => {
    // 不注册 getWebhookInfo responder：若仍发起调用，桩直接抛错（被 attempt()
    // 捕获为 network error），第二条 failed 会变成「状态未知」而非「未配置」
    await expectFailed(
      { TELEGRAM_BOT_TOKEN: undefined },
      ["必填变量未配置：TELEGRAM_BOT_TOKEN", "无法检查 Webhook：TELEGRAM_BOT_TOKEN 未配置"],
    );
    expect(stub.countOf("getWebhookInfo")).toBe(0);
  });

  it("多个必填同时缺失 → 一条按固定顺序点名多个", async () => {
    await expectFailed(
      { TELEGRAM_BOT_TOKEN: undefined, ADMIN_SECRET: undefined },
      [
        "必填变量未配置：TELEGRAM_BOT_TOKEN、ADMIN_SECRET",
        "无法检查 Webhook：TELEGRAM_BOT_TOKEN 未配置",
      ],
    );
    expect(stub.countOf("getWebhookInfo")).toBe(0);
  });

  it("空串 / 纯空白视同未配置", async () => {
    stubWebhookOk();
    await expectFailed({ SUPPORT_CHAT_ID: "   " }, ["必填变量未配置：SUPPORT_CHAT_ID"]);
  });

  it("SUPPORT_CHAT_ID 非法（缺 -100 前缀 / 非整数）", async () => {
    stubWebhookOk();
    await expectFailed({ SUPPORT_CHAT_ID: "1234567890" }, [
      "SUPPORT_CHAT_ID 非法：应为 -100 开头的整数",
    ]);
    await expectFailed({ SUPPORT_CHAT_ID: "-100abc" }, [
      "SUPPORT_CHAT_ID 非法：应为 -100 开头的整数",
    ]);
  });

  it("ADMIN_IDS 解析不出任何合法 ID", async () => {
    stubWebhookOk();
    await expectFailed({ ADMIN_IDS: "abc" }, ["ADMIN_IDS 非法：未解析出任何合法用户 ID"]);
    await expectFailed({ ADMIN_IDS: "abc,3.5" }, ["ADMIN_IDS 非法：未解析出任何合法用户 ID"]);
  });

  it("ADMIN_IDS 含无法解析的项 → 按位置（第 N 个）逐条点名", async () => {
    stubWebhookOk();
    await expectFailed({ ADMIN_IDS: "111111111,abc,222222222" }, [
      "ADMIN_IDS 含无法解析的项（第 2 个）",
    ]);
    // 多个非法项各报一条；空 token 容忍（与 parseAdminIds 跳过语义对齐）
    await expectFailed({ ADMIN_IDS: "111111111,abc,,x" }, [
      "ADMIN_IDS 含无法解析的项（第 2 个）",
      "ADMIN_IDS 含无法解析的项（第 4 个）",
    ]);
  });

  it("ADMIN_IDS 尾逗号（空 token）不报错——合法配置", async () => {
    stubWebhookOk();
    const res = await handleSelfCheck(new Request(SELF_URL), envWith({ ADMIN_IDS: "111111111," }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ status: "ok", version: VERSION }));
  });

  it("三个 Secret 两两相同 → 各自报一条（指出哪两个相同）", async () => {
    stubWebhookOk();
    await expectFailed({ TELEGRAM_WEBHOOK_SECRET: "test-admin-secret" }, [
      "密钥变量取值重复：TELEGRAM_WEBHOOK_SECRET 与 ADMIN_SECRET 相同（三者必须互异）",
    ]);
    await expectFailed({ TELEGRAM_BOT_TOKEN: "test-webhook-secret" }, [
      "密钥变量取值重复：TELEGRAM_BOT_TOKEN 与 TELEGRAM_WEBHOOK_SECRET 相同（三者必须互异）",
    ]);
    await expectFailed({ TELEGRAM_BOT_TOKEN: "test-admin-secret" }, [
      "密钥变量取值重复：TELEGRAM_BOT_TOKEN 与 ADMIN_SECRET 相同（三者必须互异）",
    ]);
    // 三者全同 → 三条齐全
    await expectFailed(
      {
        TELEGRAM_BOT_TOKEN: "same-secret",
        TELEGRAM_WEBHOOK_SECRET: "same-secret",
        ADMIN_SECRET: "same-secret",
      },
      [
        "密钥变量取值重复：TELEGRAM_BOT_TOKEN 与 TELEGRAM_WEBHOOK_SECRET 相同（三者必须互异）",
        "密钥变量取值重复：TELEGRAM_BOT_TOKEN 与 ADMIN_SECRET 相同（三者必须互异）",
        "密钥变量取值重复：TELEGRAM_WEBHOOK_SECRET 与 ADMIN_SECRET 相同（三者必须互异）",
      ],
    );
  });

  it("选填变量已配置但非法 → 点名 + 运行时回退默认值", async () => {
    stubWebhookOk();
    await expectFailed({ MAX_ATTEMPTS: "abc" }, [
      "MAX_ATTEMPTS 已配置但非法（正整数），运行时将回退默认 3",
    ]);
    await expectFailed({ MAX_ATTEMPTS: "0" }, [
      "MAX_ATTEMPTS 已配置但非法（正整数），运行时将回退默认 3",
    ]);
    await expectFailed({ MAX_MESSAGES_PER_MINUTE: "0" }, [
      "MAX_MESSAGES_PER_MINUTE 已配置但非法（正整数），运行时将回退默认 20",
    ]);
    await expectFailed({ VERIFY_TTL_HOURS: "-1" }, [
      "VERIFY_TTL_HOURS 已配置但非法（非负整数），运行时将回退默认 0",
    ]);
  });
});

describe("Webhook 绑定检查（构造 env 直调 + 桩）", () => {
  it("url 为空 → 未绑定提示（含 /setwebhook/<ADMIN_SECRET> 指引）", async () => {
    stubWebhookOk("");
    await expectFailed({}, ["webhook 未绑定，请访问 /setwebhook/<ADMIN_SECRET> 完成绑定"]);
    expect(stub.countOf("getWebhookInfo")).toBe(1);
  });

  it("url 指向他处 → 指出实际与期望地址", async () => {
    stubWebhookOk("https://elsewhere.example.com/webhook");
    await expectFailed({}, [
      "webhook 指向错误地址：https://elsewhere.example.com/webhook" +
        "（应为 https://example.com/webhook，请重新执行 /setwebhook）",
    ]);
  });

  it("getWebhookInfo 网络错误 → 状态未知（已消毒概要），单次调用不重试", async () => {
    stub.always("getWebhookInfo", { throwError: true });
    await expectFailed({}, [
      "Webhook 状态未知：getWebhookInfo 调用失败（getWebhookInfo network error）",
    ]);
    expect(stub.countOf("getWebhookInfo")).toBe(1);
  });

  it("getWebhookInfo ok:false（permanent）→ 状态未知（已消毒概要）", async () => {
    stub.always("getWebhookInfo", {
      status: 400,
      json: { ok: false, description: "Unauthorized" },
    });
    await expectFailed({}, [
      "Webhook 状态未知：getWebhookInfo 调用失败（getWebhookInfo HTTP 400: Unauthorized）",
    ]);
    expect(stub.countOf("getWebhookInfo")).toBe(1);
  });

  it("last_error_message 非空 → 回显 Telegram 原文（地址正确，仅此一条）", async () => {
    stub.always("getWebhookInfo", {
      json: {
        ok: true,
        result: {
          url: EXPECTED_WEBHOOK_URL,
          pending_update_count: 2,
          last_error_message: "Wrong response from an HTTPS webhook: 500 Internal Server Error",
        },
      },
    });
    await expectFailed({}, [
      "Telegram 最近投递错误：Wrong response from an HTTPS webhook: 500 Internal Server Error",
    ]);
  });

  it("指向错误 + last_error_message → 两条并列", async () => {
    stub.always("getWebhookInfo", {
      json: {
        ok: true,
        result: { url: "https://old.example.com/webhook", last_error_message: "Bad Gateway" },
      },
    });
    await expectFailed({}, [
      "webhook 指向错误地址：https://old.example.com/webhook" +
        "（应为 https://example.com/webhook，请重新执行 /setwebhook）",
      "Telegram 最近投递错误：Bad Gateway",
    ]);
  });
});
