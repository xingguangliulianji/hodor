/**
 * extractContent 纯函数直测（T22，design.md「测试设计」）：
 * 8 类有效载荷逐类（photo 取最大尺寸、并列取后者；audio 为 2026-09-30
 * 真机验收增补）、caption 透传、畸形字段（photo 空数组 / file_id 非串 /
 * 字段非对象）→ null、支持集之外（video_note / contact）→ null、
 * 空对象 → null。
 */
import { describe, expect, it } from "vitest";
import { extractContent } from "../src/pipeline/content";
import type { TelegramMessageRef } from "../src/pipeline/classify";

/** 最小合法 message 骨架（extractContent 只读内容字段，不触 chat/from） */
function message(overrides: Record<string, unknown> = {}): TelegramMessageRef {
  return {
    message_id: 1,
    chat: { id: 7001, type: "private" },
    ...overrides,
  } as TelegramMessageRef;
}

/** 单尺寸 photo 数组（最大尺寸即唯一尺寸） */
function photoSizes(fileId: string, width = 800): unknown[] {
  return [{ file_id: fileId, file_unique_id: "u", width, height: 600 }];
}

describe("content: 7 类有效载荷", () => {
  it("text 非空 → { type: 'text', text }", () => {
    expect(extractContent(message({ text: "你好" }))).toEqual({ type: "text", text: "你好" });
  });

  it("photo 取最大尺寸（width 最大）的 file_id，caption 一并透传", () => {
    const payload = extractContent(
      message({
        photo: [
          { file_id: "small", file_unique_id: "u1", width: 320, height: 240 },
          { file_id: "large", file_unique_id: "u2", width: 1280, height: 960 },
          { file_id: "medium", file_unique_id: "u3", width: 800, height: 600 },
        ],
        caption: "看这张图",
      }),
    );
    expect(payload).toEqual({ type: "photo", fileId: "large", caption: "看这张图" });
  });

  it("photo 宽度并列 → 取后者（确定性）", () => {
    const payload = extractContent(
      message({
        photo: [
          { file_id: "first", file_unique_id: "u1", width: 640, height: 480 },
          { file_id: "second", file_unique_id: "u2", width: 640, height: 480 },
        ],
      }),
    );
    expect(payload).toEqual({ type: "photo", fileId: "second", caption: undefined });
  });

  it("video / animation / document / voice / audio → 对应类型 + fileId + caption", () => {
    expect(extractContent(message({ video: { file_id: "v1" }, caption: "视频说明" }))).toEqual({
      type: "video",
      fileId: "v1",
      caption: "视频说明",
    });
    expect(extractContent(message({ animation: { file_id: "gif1" }, caption: "动图" }))).toEqual({
      type: "animation",
      fileId: "gif1",
      caption: "动图",
    });
    expect(extractContent(message({ document: { file_id: "doc1" }, caption: "文件" }))).toEqual({
      type: "document",
      fileId: "doc1",
      caption: "文件",
    });
    expect(extractContent(message({ voice: { file_id: "voice1" } }))).toEqual({
      type: "voice",
      fileId: "voice1",
      caption: undefined,
    });
    // audio（音乐文件，2026-09-30 增补）：file_id + caption，title/performer 不透传
    expect(
      extractContent(message({ audio: { file_id: "aud1", title: "歌名", performer: "歌手" }, caption: "一首歌" })),
    ).toEqual({ type: "audio", fileId: "aud1", caption: "一首歌" });
  });

  it("sticker → 携带 fileId 且忽略 caption（Telegram 语义上不可能携带）", () => {
    expect(
      extractContent(message({ sticker: { file_id: "stk1" }, caption: "不该出现" })),
    ).toEqual({ type: "sticker", fileId: "stk1" });
  });
});

describe("content: 畸形与边界 → null / 视同缺席", () => {
  it("空对象（无 text 无媒体）→ null", () => {
    expect(extractContent(message())).toBeNull();
  });

  it("text 空串无媒体 → null；纯空白仍算非空文本（阶段 2 同语义，照常中继）", () => {
    expect(extractContent(message({ text: "" }))).toBeNull();
    expect(extractContent(message({ text: "   " }))).toEqual({ type: "text", text: "   " });
  });

  it("photo 空数组 → null", () => {
    expect(extractContent(message({ photo: [] }))).toBeNull();
  });

  it("photo 最大尺寸项的 file_id 非字符串 → photo 视同缺席 → null", () => {
    expect(
      extractContent(
        message({
          photo: [
            { file_id: "ok", file_unique_id: "u1", width: 320, height: 240 },
            { file_id: 12345, file_unique_id: "u2", width: 1280, height: 960 },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("媒体字段为非对象（字符串 / 数组）→ 视同缺席 → null", () => {
    expect(extractContent(message({ video: "v1" }))).toBeNull();
    expect(extractContent(message({ voice: ["v1"] }))).toBeNull();
    expect(extractContent(message({ audio: "aud1" }))).toBeNull();
  });

  it("file_id 空串 / 缺失 → 该类型视同缺席 → null", () => {
    expect(extractContent(message({ document: { file_id: "" } }))).toBeNull();
    expect(extractContent(message({ animation: { file_unique_id: "u" } }))).toBeNull();
    expect(extractContent(message({ audio: { file_id: "", title: "歌名" } }))).toBeNull();
  });

  it("caption 非字符串 / 空串 → 不携带", () => {
    const payload = extractContent(message({ photo: photoSizes("p1"), caption: 12345 }));
    expect(payload).toEqual({ type: "photo", fileId: "p1", caption: undefined });
    const empty = extractContent(message({ photo: photoSizes("p2"), caption: "" }));
    expect(empty).toEqual({ type: "photo", fileId: "p2", caption: undefined });
  });
});

describe("content: 支持集之外 → null（受控静默忽略）", () => {
  it("video_note / contact → null（即便 file_id 形态合法；audio 已于 2026-09-30 纳入支持集）", () => {
    expect(extractContent(message({ video_note: { file_id: "vn1", length: 30 } }))).toBeNull();
    expect(
      extractContent(message({ contact: { user_id: 1, first_name: "C", phone_number: "+1" } })),
    ).toBeNull();
  });

  it("location / poll / dice → null", () => {
    expect(extractContent(message({ location: { latitude: 1, longitude: 2 } }))).toBeNull();
    expect(extractContent(message({ poll: { id: "p", question: "q", options: [] } }))).toBeNull();
    expect(extractContent(message({ dice: { emoji: "🎲", value: 5 } }))).toBeNull();
  });

  it("text 与媒体并存时 text 优先（Telegram 实际不并发，防御确定性）", () => {
    expect(extractContent(message({ text: "文字", photo: photoSizes("p1") }))).toEqual({
      type: "text",
      text: "文字",
    });
  });
});
