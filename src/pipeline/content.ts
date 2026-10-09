/**
 * 内容抽取与中继分发（T22，design.md「模块与数据流」§一.1）。
 *
 * - extractContent：把不可信的 message 媒体/文本字段校验并归一为
 *   ContentPayload。支持集固定 8 类（text + 7 媒体，audio 于 2026-09-30
 *   真机验收按用户要求纳入）；支持集之外（video_note / contact /
 *   location / poll / dice / 空 text 无媒体…）一律返回 null = 受控静默
 *   忽略（沿用阶段 2「先于一切副作用」语义，首条此类消息不建档不建 topic，
 *   update 仍按成功处理）。
 * - relayContent：按 type 分发到 client 对应 send 方法（per-type send 按
 *   file_id 直传，绝不下载内容）；threadId 存在时带 message_thread_id
 *   （入站落 topic），私聊不传。本函数只组参调用 client——pipeline 内
 *   禁止直接 fetch（分层约定），错误分类只在 client。
 */
import type { TelegramClient, TelegramResult } from "../telegram/types";
import type { TelegramMessageRef } from "./classify";

/** 支持集固定 8 类（T22 + audio 增补）：扩展留待需要时（design.md「明确不做」） */
export type ContentType =
  | "text"
  | "photo"
  | "video"
  | "voice"
  | "audio"
  | "document"
  | "sticker"
  | "animation";

/** 中继载荷：text 类型带 text，媒体类型带 fileId（sticker 无 caption） */
export interface ContentPayload {
  type: ContentType;
  /** text 类型的正文（非空字符串，extractContent 保证） */
  text?: string;
  /** 媒体类型的 file_id（非空字符串，extractContent 保证） */
  fileId?: string;
  /** 媒体 caption（非空字符串才携带；sticker 忽略） */
  caption?: string;
}

/** 中继目标：入站 = 客服群 + thread；出站 = 用户私聊（不带 thread） */
export interface RelayTarget {
  chatId: number;
  threadId?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 媒体字段形态校验：须为对象且 file_id 为非空字符串，否则该类型视同缺席 */
function mediaFileId(field: unknown): string | null {
  if (!isRecord(field)) return null;
  const fileId = field.file_id;
  return typeof fileId === "string" && fileId !== "" ? fileId : null;
}

/** caption 归一：非空字符串才有（空串 / 非串视同无） */
function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 从 message 抽取中继载荷；支持集之外 / 畸形 → null。
 *
 * 探测顺序 text → photo → video → animation → document → voice → audio →
 * sticker：Telegram 单条消息只携带一种媒体，顺序只为确定性（不可信输入
 * 逐字段校验）。audio 紧随 voice（同为声音类，2026-09-30 真机验收纳入）。
 * photo 取最大尺寸（width 最大，并列取后者）的 file_id。
 */
export function extractContent(message: TelegramMessageRef): ContentPayload | null {
  const text = nonEmptyText(message.text);
  if (text !== undefined) return { type: "text", text };

  const caption = nonEmptyText(message.caption);

  if (Array.isArray(message.photo)) {
    // 空数组视同缺席；并列宽度取后者（>=），非对象元素按 -Infinity 参与排序
    let bestIndex = -1;
    let bestWidth = -Infinity;
    message.photo.forEach((size, index) => {
      const width = isRecord(size) && typeof size.width === "number" ? size.width : -Infinity;
      if (width >= bestWidth) {
        bestWidth = width;
        bestIndex = index;
      }
    });
    // 中选尺寸的 file_id 畸形（非串/空串）→ photo 整体视同缺席
    const photoId = bestIndex >= 0 ? mediaFileId(message.photo[bestIndex]) : null;
    if (photoId !== null) return { type: "photo", fileId: photoId, caption };
  }

  // Telegram 单条消息只携带一种媒体：任一命中即返回
  const videoId = mediaFileId(message.video);
  if (videoId !== null) return { type: "video", fileId: videoId, caption };

  const animationId = mediaFileId(message.animation);
  if (animationId !== null) return { type: "animation", fileId: animationId, caption };

  const documentId = mediaFileId(message.document);
  if (documentId !== null) return { type: "document", fileId: documentId, caption };

  const voiceId = mediaFileId(message.voice);
  if (voiceId !== null) return { type: "voice", fileId: voiceId, caption };

  // audio（音乐文件）紧随 voice：探测顺序只为确定性；title/performer 等
  // 元数据不透传（与其他类型一致，只 file_id + caption）
  const audioId = mediaFileId(message.audio);
  if (audioId !== null) return { type: "audio", fileId: audioId, caption };

  // sticker 无 caption（Telegram 语义上不可能携带，忽略 caption 字段）
  const stickerId = mediaFileId(message.sticker);
  if (stickerId !== null) return { type: "sticker", fileId: stickerId };

  return null;
}

/**
 * 按 payload.type 分发中继：text → sendMessage，媒体 → 对应 send*（file_id 直传）。
 * 返回 client 的统一三态结果（不在此消费——retryable/permanent 分支由调用方定夺）。
 * text / fileId 由 extractContent 构造保证非空。
 */
export async function relayContent(
  client: TelegramClient,
  payload: ContentPayload,
  target: RelayTarget,
): Promise<TelegramResult<{ message_id: number }>> {
  const { chatId, threadId } = target;
  const thread = threadId !== undefined ? { message_thread_id: threadId } : {};

  switch (payload.type) {
    case "text":
      return client.sendMessage({ chat_id: chatId, text: payload.text!, ...thread });
    case "photo":
      return client.sendPhoto({
        chat_id: chatId,
        photo: payload.fileId!,
        caption: payload.caption,
        ...thread,
      });
    case "video":
      return client.sendVideo({
        chat_id: chatId,
        video: payload.fileId!,
        caption: payload.caption,
        ...thread,
      });
    case "voice":
      return client.sendVoice({
        chat_id: chatId,
        voice: payload.fileId!,
        caption: payload.caption,
        ...thread,
      });
    case "audio":
      return client.sendAudio({
        chat_id: chatId,
        audio: payload.fileId!,
        caption: payload.caption,
        ...thread,
      });
    case "document":
      return client.sendDocument({
        chat_id: chatId,
        document: payload.fileId!,
        caption: payload.caption,
        ...thread,
      });
    case "sticker":
      return client.sendSticker({ chat_id: chatId, sticker: payload.fileId!, ...thread });
    case "animation":
      return client.sendAnimation({
        chat_id: chatId,
        animation: payload.fileId!,
        caption: payload.caption,
        ...thread,
      });
  }
}
