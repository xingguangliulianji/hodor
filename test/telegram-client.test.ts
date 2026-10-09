/**
 * telegram client 分类矩阵全量（.trellis/spec/backend/error-handling.md 必需测试）。
 *
 * 每行矩阵 + 两条 429 路径的调用计数断言 + token 绝不泄漏。
 * 出站请求经 telegramFetchStub 拦截（fetchMock 已在 vitest-pool-workers 0.13+
 * 移除，官方替代为直接替换 globalThis.fetch），测试内无任何真实网络请求。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTelegramClient } from "../src/telegram/client";
import type { TelegramError, TelegramResult } from "../src/telegram/types";
import {
  stubTelegramFetch,
  type TelegramFetchStub,
} from "./helpers/telegramFetchStub";

const TOKEN = "123456:TEST-TOKEN-must-never-leak";

/** 断言为失败态并收窄到 TelegramError */
function asError<T>(result: TelegramResult<T>): TelegramError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable: expected error");
  return result;
}

/** token 绝不出现在任何错误文本里 */
function expectNoTokenLeak(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(TOKEN);
}

describe("telegram client: 分类矩阵", () => {
  let stub: TelegramFetchStub;
  let client: ReturnType<typeof createTelegramClient>;

  beforeEach(() => {
    stub = stubTelegramFetch();
    client = createTelegramClient(TOKEN);
  });
  afterEach(() => {
    stub.restore();
  });

  it("200 + ok:true → Ok，result 直接透传", async () => {
    stub.always("getMe", {
      status: 200,
      json: { ok: true, result: { id: 42, is_bot: true, username: "hodor_bot", first_name: "hodor" } },
    });
    const result = await client.getMe();
    expect(result).toEqual({
      ok: true,
      result: { id: 42, is_bot: true, username: "hodor_bot", first_name: "hodor" },
    });
  });

  it("200 + ok:false（信封带 error_code）→ permanent，errorMessage=description，errorCode 透传", async () => {
    stub.always("getMe", {
      status: 200,
      json: { ok: false, error_code: 400, description: "Bad Request: chat not found" },
    });
    const error = asError(await client.getMe());
    expect(error.kind).toBe("permanent");
    expect(error.errorCode).toBe(400);
    expect(error.errorMessage).toContain("Bad Request: chat not found");
    expectNoTokenLeak(error);
  });

  it("200 + ok:false（信封无 error_code）→ permanent，errorCode 不存在", async () => {
    stub.always("getMe", {
      status: 200,
      json: { ok: false, description: "Unauthorized" },
    });
    const error = asError(await client.getMe());
    expect(error.kind).toBe("permanent");
    expect(error.errorCode).toBeUndefined();
    expectNoTokenLeak(error);
  });

  it("429 + retry_after=1 → 原地 sleep 重试恰好一次，第二次 200 → Ok（恰 2 次调用）", async () => {
    stub.on("getMe", (i) =>
      i === 0
        ? {
            status: 429,
            json: {
              ok: false,
              error_code: 429,
              description: "Too Many Requests: retry after 1",
              parameters: { retry_after: 1 },
            },
          }
        : {
            status: 200,
            json: { ok: true, result: { id: 42, username: "hodor_bot", first_name: "hodor" } },
          },
    );
    const result = await client.getMe();
    expect(result).toEqual({
      ok: true,
      result: { id: 42, username: "hodor_bot", first_name: "hodor" },
    });
    expect(stub.countOf("getMe")).toBe(2);
  });

  it("429 + retry_after=1 → 重试后仍 429（新值 7）→ retryable 携带新 retryAfterSeconds（恰 2 次调用，绝不重试两次）", async () => {
    stub.on("getMe", (i) => ({
      status: 429,
      json: {
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: i === 0 ? 1 : 7 },
      },
    }));
    const error = asError(await client.getMe());
    expect(error.kind).toBe("retryable");
    expect(error.retryAfterSeconds).toBe(7); // 新值，不是首次的 1
    expectNoTokenLeak(error);
    expect(stub.countOf("getMe")).toBe(2);
  });

  it("429 + retry_after=10（> 3s）→ 不重试，retryable（恰 1 次调用）", async () => {
    stub.always("getMe", {
      status: 429,
      json: {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 10",
        parameters: { retry_after: 10 },
      },
    });
    const error = asError(await client.getMe());
    expect(error.kind).toBe("retryable");
    expect(error.retryAfterSeconds).toBe(10);
    expectNoTokenLeak(error);
    expect(stub.countOf("getMe")).toBe(1);
  });

  it("429 无 retry_after → retryable 且不带 retryAfterSeconds（不重试）", async () => {
    stub.always("getMe", {
      status: 429,
      json: { ok: false, error_code: 429, description: "Too Many Requests" },
    });
    const error = asError(await client.getMe());
    expect(error.kind).toBe("retryable");
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(stub.countOf("getMe")).toBe(1);
  });

  it("403 → permanent，errorCode === 403（消费方按数字码分支 bot_blocked_by_user）", async () => {
    stub.always("copyMessage", {
      status: 403,
      json: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
    });
    const error = asError(
      await client.copyMessage({ from_chat_id: 1, from_message_id: 2, chat_id: 3 }),
    );
    expect(error.kind).toBe("permanent");
    expect(error.errorCode).toBe(403);
    expectNoTokenLeak(error);
  });

  it("400 → permanent（毒丸），errorCode 透传", async () => {
    stub.always("copyMessage", {
      status: 400,
      json: { ok: false, error_code: 400, description: "Bad Request: message to copy not found" },
    });
    const error = asError(
      await client.copyMessage({ from_chat_id: 1, from_message_id: 2, chat_id: 3 }),
    );
    expect(error.kind).toBe("permanent");
    expect(error.errorCode).toBe(400);
    expectNoTokenLeak(error);
  });

  it("其他 4xx（418）→ permanent，errorCode 透传", async () => {
    stub.always("createForumTopic", {
      status: 418,
      json: { ok: false, error_code: 418, description: "I'm a teapot" },
    });
    const error = asError(
      await client.createForumTopic({ chat_id: -1001234567890, name: "张三" }),
    );
    expect(error.kind).toBe("permanent");
    expect(error.errorCode).toBe(418);
    expectNoTokenLeak(error);
  });

  it("5xx → retryable", async () => {
    stub.always("deleteWebhook", {
      status: 502,
      json: { ok: false, error_code: 502, description: "Bad Gateway" },
    });
    const error = asError(await client.deleteWebhook());
    expect(error.kind).toBe("retryable");
    expect(error.errorCode).toBeUndefined(); // retryable 不携带 errorCode
    expectNoTokenLeak(error);
  });

  it("网络错误（fetch 抛出）→ retryable，且不透传含 URL 的异常文本", async () => {
    stub.always("getMe", { throwError: true });
    const error = asError(await client.getMe());
    expect(error.kind).toBe("retryable");
    // 只含方法名 + 语义，绝不含 token / URL / 底层异常文本
    expect(error.errorMessage).toBe("getMe network error");
    expectNoTokenLeak(error);
  });

  it("200 + 非 JSON body → retryable", async () => {
    stub.always("getMe", { status: 200, rawBody: "<html>gateway error page</html>" });
    const error = asError(await client.getMe());
    expect(error.kind).toBe("retryable");
    expect(error.errorMessage).toContain("non-JSON");
    expectNoTokenLeak(error);
  });

  it("200 + 合法 JSON 但无 ok 字段 → retryable", async () => {
    stub.always("getMe", { status: 200, json: { hello: "world" } });
    const error = asError(await client.getMe());
    expect(error.kind).toBe("retryable");
    expect(error.errorMessage).toContain("without ok field");
    expectNoTokenLeak(error);
  });
});

describe("telegram client: 方法契约", () => {
  let stub: TelegramFetchStub;
  let client: ReturnType<typeof createTelegramClient>;

  beforeEach(() => {
    stub = stubTelegramFetch();
    client = createTelegramClient(TOKEN);
  });
  afterEach(() => {
    stub.restore();
  });

  it("setWebhook：入参映射为 url / secret_token / allowed_updates", async () => {
    stub.always("setWebhook", { status: 200, json: { ok: true, result: true } });
    const result = await client.setWebhook({
      url: "https://worker.example.com/webhook",
      secretToken: "the-webhook-secret",
      allowedUpdates: ["message", "callback_query"],
    });
    expect(result).toEqual({ ok: true, result: true });
    expect(stub.callsOf("setWebhook")[0].body).toEqual({
      url: "https://worker.example.com/webhook",
      secret_token: "the-webhook-secret",
      allowed_updates: ["message", "callback_query"],
    });
  });

  it("copyMessage：蛇形参数原样透传（含 / 不含 message_thread_id）", async () => {
    stub.always("copyMessage", {
      status: 200,
      json: { ok: true, result: { message_id: 321 } },
    });
    const withThread = await client.copyMessage({
      from_chat_id: 100,
      from_message_id: 200,
      chat_id: -1001234567890,
      message_thread_id: 7,
    });
    expect(withThread).toEqual({ ok: true, result: { message_id: 321 } });
    expect(stub.callsOf("copyMessage")[0].body).toEqual({
      from_chat_id: 100,
      from_message_id: 200,
      chat_id: -1001234567890,
      message_thread_id: 7,
    });

    await client.copyMessage({ from_chat_id: 1, from_message_id: 2, chat_id: 3 });
    expect(stub.callsOf("copyMessage")[1].body).toEqual({
      from_chat_id: 1,
      from_message_id: 2,
      chat_id: 3,
    });
  });

  it("createForumTopic / deleteForumTopic / deleteWebhook：出参形状正确", async () => {
    stub.always("createForumTopic", {
      status: 200,
      json: { ok: true, result: { message_thread_id: 555 } },
    });
    stub.always("deleteForumTopic", { status: 200, json: { ok: true, result: true } });
    stub.always("deleteWebhook", { status: 200, json: { ok: true, result: true } });

    const topic = await client.createForumTopic({ chat_id: -1001234567890, name: "张三" });
    expect(topic).toEqual({ ok: true, result: { message_thread_id: 555 } });
    expect(stub.callsOf("createForumTopic")[0].body).toEqual({
      chat_id: -1001234567890,
      name: "张三",
    });

    const deleted = await client.deleteForumTopic({
      chat_id: -1001234567890,
      message_thread_id: 555,
    });
    expect(deleted).toEqual({ ok: true, result: true });
    expect(stub.callsOf("deleteForumTopic")[0].body).toEqual({
      chat_id: -1001234567890,
      message_thread_id: 555,
    });

    expect(await client.deleteWebhook()).toEqual({ ok: true, result: true });
  });

  it("所有请求都打到 https://api.telegram.org/bot<token>/<method>（base URL 契约）", async () => {
    stub.always("getMe", { status: 200, json: { ok: true, result: { id: 1 } } });
    await client.getMe();
    expect(stub.callsOf("getMe")[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
    expect(stub.callsOf("getMe")[0].httpMethod).toBe("POST");
  });
});

describe("telegram client: T22/T24 新方法（全部经 request()，零分类旁路）", () => {
  let stub: TelegramFetchStub;
  let client: ReturnType<typeof createTelegramClient>;
  beforeEach(() => {
    stub = stubTelegramFetch();
    client = createTelegramClient(TOKEN);
  });
  afterEach(() => {
    stub.restore();
  });

  it("sendPhoto：file_id + caption + thread 蛇形透传，出参 MessageIdResult", async () => {
    stub.always("sendPhoto", { status: 200, json: { ok: true, result: { message_id: 777 } } });
    const result = await client.sendPhoto({
      chat_id: -1001234567890,
      photo: "AgACAgUAA…",
      caption: "用户配的说明",
      message_thread_id: 100,
    });
    expect(result).toEqual({ ok: true, result: { message_id: 777 } });
    // 精确键集：无多余键，caption 字段名即 caption
    expect(stub.callsOf("sendPhoto")[0].body).toEqual({
      chat_id: -1001234567890,
      photo: "AgACAgUAA…",
      caption: "用户配的说明",
      message_thread_id: 100,
    });
  });

  it("sendSticker：sticker 键名 + thread；类型上就不存在 caption 字段", async () => {
    stub.always("sendSticker", { status: 200, json: { ok: true, result: { message_id: 778 } } });
    const result = await client.sendSticker({
      chat_id: -1001234567890,
      sticker: "CAACAgIAA…",
      message_thread_id: 100,
    });
    expect(result).toEqual({ ok: true, result: { message_id: 778 } });
    expect(stub.callsOf("sendSticker")[0].body).toEqual({
      chat_id: -1001234567890,
      sticker: "CAACAgIAA…",
      message_thread_id: 100,
    });
  });

  it("sendVideo / sendVoice / sendAudio / sendDocument / sendAnimation：各字段名正确，可选键缺省即剔除", async () => {
    stub.always("sendVideo", { status: 200, json: { ok: true, result: { message_id: 9 } } });
    stub.always("sendVoice", { status: 200, json: { ok: true, result: { message_id: 9 } } });
    stub.always("sendAudio", { status: 200, json: { ok: true, result: { message_id: 9 } } });
    stub.always("sendDocument", { status: 200, json: { ok: true, result: { message_id: 9 } } });
    stub.always("sendAnimation", { status: 200, json: { ok: true, result: { message_id: 9 } } });

    // 纯 file_id（无 caption / thread）：键集中只剩 chat_id + 媒体字段
    await client.sendVideo({ chat_id: 7001, video: "vid_1" });
    expect(stub.callsOf("sendVideo")[0].body).toEqual({ chat_id: 7001, video: "vid_1" });

    // voice 可带 caption
    await client.sendVoice({ chat_id: 7001, voice: "voice_1", caption: "语音说明" });
    expect(stub.callsOf("sendVoice")[0].body).toEqual({
      chat_id: 7001,
      voice: "voice_1",
      caption: "语音说明",
    });

    // audio（2026-09-30 增补）：audio 字段名 + caption + thread 透传，
    // title/performer 元数据不在参数集（调用方只组 file_id + caption）
    await client.sendAudio({ chat_id: 7001, audio: "aud_1", caption: "一首歌", message_thread_id: 6 });
    expect(stub.callsOf("sendAudio")[0].body).toEqual({
      chat_id: 7001,
      audio: "aud_1",
      caption: "一首歌",
      message_thread_id: 6,
    });

    // document 可带 thread
    await client.sendDocument({ chat_id: 7001, document: "doc_1", message_thread_id: 5 });
    expect(stub.callsOf("sendDocument")[0].body).toEqual({
      chat_id: 7001,
      document: "doc_1",
      message_thread_id: 5,
    });

    const animation = await client.sendAnimation({ chat_id: 7001, animation: "gif_1" });
    expect(animation).toEqual({ ok: true, result: { message_id: 9 } });
    expect(stub.callsOf("sendAnimation")[0].body).toEqual({ chat_id: 7001, animation: "gif_1" });
  });

  it("pinChatMessage：disable_notification 恒注入 true（精确键集）", async () => {
    stub.always("pinChatMessage", { status: 200, json: { ok: true, result: true } });
    const result = await client.pinChatMessage({ chat_id: -1001234567890, message_id: 500 });
    expect(result).toEqual({ ok: true, result: true });
    expect(stub.callsOf("pinChatMessage")[0].body).toEqual({
      chat_id: -1001234567890,
      message_id: 500,
      disable_notification: true,
    });
  });

  it("editMessageText：chat_id / message_id / text 透传", async () => {
    stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 500 } } });
    const result = await client.editMessageText({
      chat_id: -1001234567890,
      message_id: 500,
      text: "更新后的置顶信息",
    });
    expect(result).toEqual({ ok: true, result: { message_id: 500 } });
    expect(stub.callsOf("editMessageText")[0].body).toEqual({
      chat_id: -1001234567890,
      message_id: 500,
      text: "更新后的置顶信息",
    });
  });

  it("分类矩阵对新方法同样成立：429 retry_after=1 → 原地重试恰一次后 Ok（恰 2 次调用）", async () => {
    stub.on("sendPhoto", (i) =>
      i === 0
        ? {
            status: 429,
            json: {
              ok: false,
              error_code: 429,
              description: "Too Many Requests: retry after 1",
              parameters: { retry_after: 1 },
            },
          }
        : { status: 200, json: { ok: true, result: { message_id: 1 } } },
    );
    const result = await client.sendPhoto({ chat_id: 7001, photo: "p" });
    expect(result).toEqual({ ok: true, result: { message_id: 1 } });
    expect(stub.countOf("sendPhoto")).toBe(2);
  });

  it("分类矩阵对新方法同样成立：editMessageText 403 → permanent 且 errorCode 按数字码透传", async () => {
    stub.always("editMessageText", {
      status: 403,
      json: { ok: false, error_code: 403, description: "Forbidden: bot was blocked" },
    });
    const error = asError(
      await client.editMessageText({ chat_id: 7001, message_id: 1, text: "t" }),
    );
    expect(error.kind).toBe("permanent");
    expect(error.errorCode).toBe(403);
    expectNoTokenLeak(error);
  });

  it("分类矩阵对新方法同样成立：sendDocument 网络错误 → retryable（不透传 URL）", async () => {
    stub.always("sendDocument", { throwError: true });
    const error = asError(await client.sendDocument({ chat_id: 7001, document: "d" }));
    expect(error.kind).toBe("retryable");
    expect(error.errorMessage).toBe("sendDocument network error");
    expectNoTokenLeak(error);
  });
});

describe("telegram client: T27 阶段 4 新增（reply_markup + answerCallbackQuery）", () => {
  let stub: TelegramFetchStub;
  let client: ReturnType<typeof createTelegramClient>;
  beforeEach(() => {
    stub = stubTelegramFetch();
    client = createTelegramClient(TOKEN);
  });
  afterEach(() => {
    stub.restore();
  });

  it("sendMessage 携带 reply_markup：inline_keyboard 蛇形结构原样透传（精确键集）", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 6 } } });
    const result = await client.sendMessage({
      chat_id: 7001,
      text: "为确认你是真人，请回答：\n3 + 5 = ?",
      reply_markup: {
        inline_keyboard: [[
          { text: "7", callback_data: "v:7" },
          { text: "9", callback_data: "v:9" },
          { text: "2", callback_data: "v:2" },
          { text: "12", callback_data: "v:12" },
        ]],
      },
    });
    expect(result).toEqual({ ok: true, result: { message_id: 6 } });
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: 7001,
      text: "为确认你是真人，请回答：\n3 + 5 = ?",
      reply_markup: {
        inline_keyboard: [[
          { text: "7", callback_data: "v:7" },
          { text: "9", callback_data: "v:9" },
          { text: "2", callback_data: "v:2" },
          { text: "12", callback_data: "v:12" },
        ]],
      },
    });
  });

  it("sendMessage 不带 reply_markup：键集零多余（既有中继路径不受影响）", async () => {
    stub.always("sendMessage", { status: 200, json: { ok: true, result: { message_id: 7 } } });
    await client.sendMessage({ chat_id: -1001234567890, text: "中继正文", message_thread_id: 9 });
    expect(stub.callsOf("sendMessage")[0].body).toEqual({
      chat_id: -1001234567890,
      text: "中继正文",
      message_thread_id: 9,
    });
  });

  it("editMessageText 携带 reply_markup：答错重出（同消息换新按钮）透传", async () => {
    stub.always("editMessageText", { status: 200, json: { ok: true, result: { message_id: 6 } } });
    const result = await client.editMessageText({
      chat_id: 7001,
      message_id: 6,
      text: "回答错误，请再试一次。",
      reply_markup: { inline_keyboard: [[{ text: "4", callback_data: "v:4" }]] },
    });
    expect(result).toEqual({ ok: true, result: { message_id: 6 } });
    expect(stub.callsOf("editMessageText")[0].body).toEqual({
      chat_id: 7001,
      message_id: 6,
      text: "回答错误，请再试一次。",
      reply_markup: { inline_keyboard: [[{ text: "4", callback_data: "v:4" }]] },
    });
  });

  it("answerCallbackQuery：callbackQueryId 蛇形映射 + text 透传", async () => {
    stub.always("answerCallbackQuery", { status: 200, json: { ok: true, result: true } });
    const result = await client.answerCallbackQuery({
      callbackQueryId: "cb-abc-1",
      text: "验证通过！",
    });
    expect(result).toEqual({ ok: true, result: true });
    expect(stub.callsOf("answerCallbackQuery")[0].body).toEqual({
      callback_query_id: "cb-abc-1",
      text: "验证通过！",
    });
  });

  it("answerCallbackQuery 不带 text：键集中无 text（只终止加载态）", async () => {
    stub.always("answerCallbackQuery", { status: 200, json: { ok: true, result: true } });
    await client.answerCallbackQuery({ callbackQueryId: "cb-abc-2" });
    expect(stub.callsOf("answerCallbackQuery")[0].body).toEqual({
      callback_query_id: "cb-abc-2",
    });
  });

  it("分类矩阵对 answerCallbackQuery 同样成立：403 → permanent 且 errorCode 按数字码透传", async () => {
    stub.always("answerCallbackQuery", {
      status: 403,
      json: { ok: false, error_code: 403, description: "Forbidden: query is too old" },
    });
    const error = asError(
      await client.answerCallbackQuery({ callbackQueryId: "cb-old", text: "x" }),
    );
    expect(error.kind).toBe("permanent");
    expect(error.errorCode).toBe(403);
    expectNoTokenLeak(error);
  });
});
