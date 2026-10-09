/**
 * src/env.ts 纯函数解析矩阵（.trellis/spec/backend/env-config.md 必需测试）：
 * SUPPORT_CHAT_ID -100 前缀校验 / ADMIN_IDS 容错解析 / MAX_ATTEMPTS 缺省 3 /
 * WELCOME_TEXT 自定义欢迎语（字面 \n 解释为换行）/ 常量时间字符串比较。
 * 纯函数直测，不触碰 D1 与 SELF。
 */
import { describe, expect, it } from "vitest";
import {
  parseAdminIds,
  parseMaxAttempts,
  parseMaxMessagesPerMinute,
  parseSupportChatId,
  parseVerifyTtlHours,
  parseWelcomeText,
  timingSafeEqualStrings,
} from "../src/env";

/** 构造部分 env（模拟绑定缺失：运行时为 undefined） */
function envWith(overrides: Record<string, string | undefined>): Cloudflare.Env {
  return {
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_WEBHOOK_SECRET: "s",
    ADMIN_SECRET: "a",
    SUPPORT_CHAT_ID: "-1001234567890",
    ADMIN_IDS: "111111111",
    ...overrides,
  } as Cloudflare.Env;
}

describe("parseSupportChatId", () => {
  it("合法 -100 前缀 → 数值", () => {
    expect(parseSupportChatId(envWith({ SUPPORT_CHAT_ID: "-1001234567890" }))).toBe(-1001234567890);
    expect(parseSupportChatId(envWith({ SUPPORT_CHAT_ID: " -1009876543210 " }))).toBe(-1009876543210);
  });

  it("缺少 -100 前缀 → null", () => {
    expect(parseSupportChatId(envWith({ SUPPORT_CHAT_ID: "1234567890" }))).toBeNull();
    expect(parseSupportChatId(envWith({ SUPPORT_CHAT_ID: "-1234567890" }))).toBeNull();
    expect(parseSupportChatId(envWith({ SUPPORT_CHAT_ID: "-10" }))).toBeNull();
  });

  it("畸形值 → null", () => {
    expect(parseSupportChatId(envWith({ SUPPORT_CHAT_ID: "-100abc" }))).toBeNull();
    expect(parseSupportChatId(envWith({ SUPPORT_CHAT_ID: "-100.5" }))).toBeNull();
    expect(parseSupportChatId(envWith({ SUPPORT_CHAT_ID: "" }))).toBeNull();
    expect(parseSupportChatId(envWith({ SUPPORT_CHAT_ID: "not-a-chat" }))).toBeNull();
  });

  it("变量缺失（binding 缺席）→ null", () => {
    expect(parseSupportChatId(envWith({ SUPPORT_CHAT_ID: undefined }))).toBeNull();
  });
});

describe("parseAdminIds", () => {
  it("逗号分隔多值 → 数组", () => {
    expect(parseAdminIds(envWith({ ADMIN_IDS: "111111111,222222222" }))).toEqual([
      111111111, 222222222,
    ]);
  });

  it("空白容忍（逐 token trim）", () => {
    expect(parseAdminIds(envWith({ ADMIN_IDS: " 111111111 ,  222222222 " }))).toEqual([
      111111111, 222222222,
    ]);
  });

  it("非法 token 跳过，不致命", () => {
    expect(parseAdminIds(envWith({ ADMIN_IDS: "111111111,abc,,3.5,222222222" }))).toEqual([
      111111111, 222222222,
    ]);
  });

  it("空 / 缺失 → []（无管理员）", () => {
    expect(parseAdminIds(envWith({ ADMIN_IDS: "" }))).toEqual([]);
    expect(parseAdminIds(envWith({ ADMIN_IDS: undefined }))).toEqual([]);
    expect(parseAdminIds(envWith({ ADMIN_IDS: " , ," }))).toEqual([]);
  });
});

describe("parseMaxAttempts", () => {
  it("合法正整数 → 原值", () => {
    expect(parseMaxAttempts(envWith({ MAX_ATTEMPTS: "5" }))).toBe(5);
    expect(parseMaxAttempts(envWith({ MAX_ATTEMPTS: "1" }))).toBe(1);
    expect(parseMaxAttempts(envWith({ MAX_ATTEMPTS: " 3 " }))).toBe(3);
  });

  it("缺失 / 空串 → 缺省 3（对齐 docs/guide/deploy.md）", () => {
    expect(parseMaxAttempts(envWith({ MAX_ATTEMPTS: undefined }))).toBe(3);
    expect(parseMaxAttempts(envWith({ MAX_ATTEMPTS: "" }))).toBe(3);
  });

  it("非法 / 非正整数 → 缺省 3（先解析，不轻信输入）", () => {
    expect(parseMaxAttempts(envWith({ MAX_ATTEMPTS: "abc" }))).toBe(3);
    expect(parseMaxAttempts(envWith({ MAX_ATTEMPTS: "0" }))).toBe(3);
    expect(parseMaxAttempts(envWith({ MAX_ATTEMPTS: "-2" }))).toBe(3);
    expect(parseMaxAttempts(envWith({ MAX_ATTEMPTS: "2.5" }))).toBe(3);
  });
});

describe("parseMaxMessagesPerMinute", () => {
  it("合法正整数 → 原值", () => {
    expect(parseMaxMessagesPerMinute(envWith({ MAX_MESSAGES_PER_MINUTE: "3" }))).toBe(3);
    expect(parseMaxMessagesPerMinute(envWith({ MAX_MESSAGES_PER_MINUTE: "1" }))).toBe(1);
    expect(parseMaxMessagesPerMinute(envWith({ MAX_MESSAGES_PER_MINUTE: " 20 " }))).toBe(20);
  });

  it("缺失 / 空串 → 缺省 20（对齐 docs/guide/deploy.md 变量表）", () => {
    expect(parseMaxMessagesPerMinute(envWith({ MAX_MESSAGES_PER_MINUTE: undefined }))).toBe(20);
    expect(parseMaxMessagesPerMinute(envWith({ MAX_MESSAGES_PER_MINUTE: "" }))).toBe(20);
  });

  it("非法 / 非正整数 → 缺省 20（先解析，不轻信输入——超限文案数字来源于此）", () => {
    expect(parseMaxMessagesPerMinute(envWith({ MAX_MESSAGES_PER_MINUTE: "abc" }))).toBe(20);
    expect(parseMaxMessagesPerMinute(envWith({ MAX_MESSAGES_PER_MINUTE: "0" }))).toBe(20);
    expect(parseMaxMessagesPerMinute(envWith({ MAX_MESSAGES_PER_MINUTE: "-5" }))).toBe(20);
    expect(parseMaxMessagesPerMinute(envWith({ MAX_MESSAGES_PER_MINUTE: "2.5" }))).toBe(20);
  });
});

describe("parseWelcomeText", () => {
  it("变量缺失（binding 缺席）→ null（调用方兜底默认文案）", () => {
    expect(parseWelcomeText(envWith({ WELCOME_TEXT: undefined }))).toBeNull();
  });

  it("空串 / 纯空白（trim 后为空）→ null", () => {
    expect(parseWelcomeText(envWith({ WELCOME_TEXT: "" }))).toBeNull();
    expect(parseWelcomeText(envWith({ WELCOME_TEXT: "   \n  " }))).toBeNull();
  });

  it("自定义文案含字面 \\n（反斜杠 n 序列）→ 解释为真实换行", () => {
    expect(parseWelcomeText(envWith({ WELCOME_TEXT: "第一行\\n第二行\\n第三行" }))).toBe(
      "第一行\n第二行\n第三行",
    );
  });

  it("真实换行原样保留，与字面 \\n 混用不重复解释", () => {
    // 源串含一个真实换行 + 一个字面 \n → 各自一个换行，替换后不叠加
    expect(parseWelcomeText(envWith({ WELCOME_TEXT: "a\nb\\nc" }))).toBe("a\nb\nc");
  });

  it("前后空白 trim 后返回", () => {
    expect(parseWelcomeText(envWith({ WELCOME_TEXT: "  你好，欢迎咨询  " }))).toBe("你好，欢迎咨询");
  });
});

describe("parseVerifyTtlHours（T33 验证有效期）", () => {
  it("合法非负整数 → 原值（含 0 = 永久有效）", () => {
    expect(parseVerifyTtlHours(envWith({ VERIFY_TTL_HOURS: "1" }))).toBe(1);
    expect(parseVerifyTtlHours(envWith({ VERIFY_TTL_HOURS: "24" }))).toBe(24);
    expect(parseVerifyTtlHours(envWith({ VERIFY_TTL_HOURS: " 8 " }))).toBe(8);
    // 0 是合法值（永不重验），不与「非法回退 0」歧义
    expect(parseVerifyTtlHours(envWith({ VERIFY_TTL_HOURS: "0" }))).toBe(0);
  });

  it("缺失 / 空串 → 缺省 0（对齐 docs/guide/deploy.md 变量表）", () => {
    expect(parseVerifyTtlHours(envWith({ VERIFY_TTL_HOURS: undefined }))).toBe(0);
    expect(parseVerifyTtlHours(envWith({ VERIFY_TTL_HOURS: "" }))).toBe(0);
    expect(parseVerifyTtlHours(envWith({ VERIFY_TTL_HOURS: "   " }))).toBe(0);
  });

  it("负数 / 非整数 / 非法 → 回退 0（先解析，不轻信输入）", () => {
    expect(parseVerifyTtlHours(envWith({ VERIFY_TTL_HOURS: "-1" }))).toBe(0);
    expect(parseVerifyTtlHours(envWith({ VERIFY_TTL_HOURS: "-0.5" }))).toBe(0);
    expect(parseVerifyTtlHours(envWith({ VERIFY_TTL_HOURS: "2.5" }))).toBe(0);
    expect(parseVerifyTtlHours(envWith({ VERIFY_TTL_HOURS: "abc" }))).toBe(0);
  });
});

describe("timingSafeEqualStrings（SHA-256 摘要常量时间比较）", () => {
  it("相等 → true", async () => {
    await expect(timingSafeEqualStrings("secret-a", "secret-a")).resolves.toBe(true);
  });

  it("不等（同长度）→ false", async () => {
    await expect(timingSafeEqualStrings("secret-a", "secret-b")).resolves.toBe(false);
  });

  it("不等（不同长度）→ false：摘要定长，比较不泄漏长度信息", async () => {
    await expect(timingSafeEqualStrings("abc", "ab")).resolves.toBe(false);
    await expect(timingSafeEqualStrings("ab", "abc")).resolves.toBe(false);
  });

  it("空串：等 / 不等", async () => {
    await expect(timingSafeEqualStrings("", "")).resolves.toBe(true);
    await expect(timingSafeEqualStrings("", "x")).resolves.toBe(false);
  });
});
