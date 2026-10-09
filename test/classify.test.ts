/**
 * classifyUpdate 纯函数直测（T15 分流规则 + fail-closed 决策 + T27 callback 分流）：
 * 私聊 / 客服群带 thread / 客服群无 thread（General）/ 其他群 / 超级群非客服 /
 * 私聊 callback_query（验证题按钮）→ callback、群内 / 畸形 callback → ignore、
 * 无 message 且无 callback_query（edited_message）/ 畸形形态 /
 * supportChatId === null → 全部 ignore（部署配置坏了零副作用）。
 */
import { describe, expect, it } from "vitest";
import { classifyUpdate } from "../src/pipeline/classify";

const SUPPORT_CHAT_ID = -1001234567890;

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 1,
    from: { id: 7001, first_name: "Alice" },
    chat: { id: 7001, type: "private" },
    text: "hello",
    ...overrides,
  };
}

function update(messageField?: Record<string, unknown>): Record<string, unknown> {
  return messageField === undefined
    ? { update_id: 9001 }
    : { update_id: 9001, message: messageField };
}

/** 私聊题面按钮 callback_query 构造（overrides 直接覆盖顶层键） */
function callbackQuery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cb-1",
    from: { id: 7001, first_name: "Alice" },
    message: { message_id: 55, chat: { id: 7001, type: "private" } },
    data: "v:7",
    ...overrides,
  };
}

function callbackUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { update_id: 9005, callback_query: callbackQuery(overrides) };
}

describe("classify: 标准分流", () => {
  it("私聊 → inbound", () => {
    expect(classifyUpdate(update(message()), SUPPORT_CHAT_ID)).toBe("inbound");
  });

  it("客服超级群 + message_thread_id → outbound", () => {
    const msg = message({
      from: { id: 111111111, first_name: "Admin" },
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      message_thread_id: 100,
    });
    expect(classifyUpdate(update(msg), SUPPORT_CHAT_ID)).toBe("outbound");
  });

  it("客服群同链路但 message_thread_id 非数字 → ignore", () => {
    const msg = message({
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      message_thread_id: "100",
    });
    expect(classifyUpdate(update(msg), SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("客服群无 thread（General / 非 topic 消息）→ ignore", () => {
    const msg = message({ chat: { id: SUPPORT_CHAT_ID, type: "supergroup" } });
    expect(classifyUpdate(update(msg), SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("其他群组 → ignore", () => {
    const msg = message({ chat: { id: -1009876543210, type: "supergroup" } });
    expect(classifyUpdate(update(msg), SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("非客服的普通 group → ignore", () => {
    const msg = message({ chat: { id: -777, type: "group" } });
    expect(classifyUpdate(update(msg), SUPPORT_CHAT_ID)).toBe("ignore");
  });
});

describe("classify: callback_query 分流（T27 验证题按钮）", () => {
  it("私聊题面回调（id / from.id / message_id / chat.type 全合法）→ callback", () => {
    expect(classifyUpdate(callbackUpdate(), SUPPORT_CHAT_ID)).toBe("callback");
  });

  it("id 非字符串（缺失 / 数字）→ ignore（畸形 id 不进 answerCallbackQuery，形态防护在分流层收口）", () => {
    expect(classifyUpdate(callbackUpdate({ id: undefined }), SUPPORT_CHAT_ID)).toBe("ignore");
    expect(classifyUpdate(callbackUpdate({ id: 12345 }), SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("客服群内回调（chat.id = SUPPORT_CHAT_ID）→ group_callback（T40 wipe 确认键盘）", () => {
    expect(
      classifyUpdate(
        callbackUpdate({ message: { message_id: 55, chat: { id: SUPPORT_CHAT_ID, type: "supergroup" } } }),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("group_callback");
  });

  it("其他群内回调（非客服群）→ ignore（不存在合法按钮形态）", () => {
    expect(
      classifyUpdate(
        callbackUpdate({ message: { message_id: 55, chat: { id: -1009876543210, type: "supergroup" } } }),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("ignore");
  });

  it("缺 message（极老客户端形态）→ ignore", () => {
    expect(classifyUpdate(callbackUpdate({ message: undefined }), SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("from 缺 id / 非对象 → ignore（归属判定无依据，零副作用）", () => {
    expect(classifyUpdate(callbackUpdate({ from: {} }), SUPPORT_CHAT_ID)).toBe("ignore");
    expect(classifyUpdate(callbackUpdate({ from: "alice" }), SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("message.message_id / chat.id 非数字 → ignore", () => {
    expect(
      classifyUpdate(callbackUpdate({ message: { message_id: "55", chat: { id: 7001, type: "private" } } }), SUPPORT_CHAT_ID),
    ).toBe("ignore");
    expect(
      classifyUpdate(callbackUpdate({ message: { message_id: 55, chat: { id: "7001", type: "private" } } }), SUPPORT_CHAT_ID),
    ).toBe("ignore");
  });

  it("data 形态不在分流职责内（v:<n> 判定在 verify 管线毒丸防护）——任意 data 都 callback", () => {
    expect(classifyUpdate(callbackUpdate({ data: "junk" }), SUPPORT_CHAT_ID)).toBe("callback");
    expect(classifyUpdate(callbackUpdate({ data: undefined }), SUPPORT_CHAT_ID)).toBe("callback");
  });
});

describe("classify: 无 message / 畸形形态", () => {
  it("edited_message（无 .message）→ ignore", () => {
    const edited = { update_id: 9002, edited_message: message() };
    expect(classifyUpdate(edited, SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("callback_query 无 message 字段 → ignore", () => {
    const cb = { update_id: 9003, callback_query: { id: "1", from: { id: 7001 } } };
    expect(classifyUpdate(cb, SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("message.chat 缺 id / type / 非对象 → ignore", () => {
    expect(classifyUpdate(update(message({ chat: { type: "private" } })), SUPPORT_CHAT_ID)).toBe("ignore");
    expect(classifyUpdate(update(message({ chat: { id: 7001 } })), SUPPORT_CHAT_ID)).toBe("ignore");
    expect(classifyUpdate(update(message({ chat: null })), SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("update 本体非对象 → ignore", () => {
    expect(classifyUpdate("nope", SUPPORT_CHAT_ID)).toBe("ignore");
    expect(classifyUpdate(null, SUPPORT_CHAT_ID)).toBe("ignore");
  });
});

describe("classify: Telegram 原生 forum topic 状态事件", () => {
  it("客服群带合法 thread 的 forum_topic_closed / reopened → topic_event", () => {
    const base = {
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      message_thread_id: 123,
    };
    expect(
      classifyUpdate(update(message({ ...base, forum_topic_closed: {} })), SUPPORT_CHAT_ID),
    ).toBe("topic_event");
    expect(
      classifyUpdate(update(message({ ...base, forum_topic_reopened: {} })), SUPPORT_CHAT_ID),
    ).toBe("topic_event");
  });

  it("其他群、缺 thread、双事件或畸形事件 → ignore", () => {
    expect(
      classifyUpdate(
        update(message({ chat: { id: -1009876543210, type: "supergroup" }, message_thread_id: 123, forum_topic_closed: {} })),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("ignore");
    expect(
      classifyUpdate(update(message({ chat: { id: SUPPORT_CHAT_ID, type: "supergroup" }, forum_topic_closed: {} })), SUPPORT_CHAT_ID),
    ).toBe("ignore");
    expect(
      classifyUpdate(
        update(message({
          chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
          message_thread_id: 123,
          forum_topic_closed: {},
          forum_topic_reopened: {},
        })),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("ignore");
    expect(
      classifyUpdate(
        update(message({ chat: { id: SUPPORT_CHAT_ID, type: "supergroup" }, message_thread_id: 123, forum_topic_closed: null })),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("ignore");
    expect(
      classifyUpdate(
        update(message({ message_id: "not-an-id", chat: { id: SUPPORT_CHAT_ID, type: "supergroup" }, message_thread_id: 123, forum_topic_closed: {} })),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("ignore");
  });
});

describe("classify: supportChatId === null（env 畸形）fail-closed", () => {
  it("私聊 → ignore（宁可零副作用，不产生半吊子转发）", () => {
    expect(classifyUpdate(update(message()), null)).toBe("ignore");
  });

  it("客服群带 thread → ignore", () => {
    const msg = message({
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      message_thread_id: 100,
    });
    expect(classifyUpdate(update(msg), null)).toBe("ignore");
  });

  it("合法形态的私聊 callback → 同样 ignore（fail-closed 覆盖新分流）", () => {
    expect(classifyUpdate(callbackUpdate(), null)).toBe("ignore");
  });
});
