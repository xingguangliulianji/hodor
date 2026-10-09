/**
 * Telegram API client —— API 调用与错误分类的唯一出口。
 *
 * 分类矩阵（逐字执行 .trellis/spec/backend/error-handling.md）只存在于本文件
 * 的 request() 内；流水线模块永远看不到 HTTP 状态码：
 *
 * | Telegram 响应                          | 分类                          |
 * |----------------------------------------|-------------------------------|
 * | 200 + ok:true                          | Ok，result 直接透传            |
 * | 200 + ok:false                         | permanent（errorCode=信封值）  |
 * | 429 且 retry_after ≤ 3s                | 原地重试恰好一次；仍 429 →     |
 * |                                        | retryable 携带新值，绝不重试两次|
 * | 429 且 retry_after > 3s 或缺失          | retryable                     |
 * | 403                                    | permanent（errorCode 403）     |
 * | 400                                    | permanent（毒丸）              |
 * | 其他 4xx                               | permanent，errorCode 透传      |
 * | 5xx / 网络错误 / 非 JSON / 200 无 ok 字段 | retryable                   |
 *
 * 安全约束：token 只出现在请求 URL（https://api.telegram.org/bot<token>/），
 * 绝不出现在任何错误文本 / 日志里——fetch 抛出的原始异常可能含完整 URL，
 * 因此网络错误只回传方法名，不透传异常 message。
 */
import type {
  AnswerCallbackQueryParams,
  CloseForumTopicParams,
  CopyMessageParams,
  CopyMessageResult,
  CreateForumTopicParams,
  CreateForumTopicResult,
  DeleteForumTopicParams,
  DeleteMessageParams,
  DeleteMyCommandsParams,
  EditMessageTextParams,
  ForwardMessageParams,
  ForwardMessageResult,
  MessageIdResult,
  PinChatMessageParams,
  ReopenForumTopicParams,
  SendAnimationParams,
  SendAudioParams,
  SendDocumentParams,
  SendPhotoParams,
  SendStickerParams,
  SendVideoParams,
  SendVoiceParams,
  SendMessageParams,
  SendMessageResult,
  SetMyCommandsParams,
  SetWebhookParams,
  TelegramBotUser,
  TelegramClient,
  TelegramResult,
  WebhookInfo,
} from "./types";

/** 429 时允许原地（sleep 后）重试的 retry_after 上限（秒） */
const IMMEDIATE_RETRY_MAX_SECONDS = 3;

const API_ORIGIN = "https://api.telegram.org";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 信封必须是对象才可读字段 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 从信封安全取数字字段 */
function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** 已消毒的错误摘要：只含方法名 + HTTP 状态 + 信封 description，绝不含 URL/token */
function sanitizedMessage(method: string, status: number, description?: unknown): string {
  const desc = typeof description === "string" && description !== "" ? description : undefined;
  return desc ? `${method} HTTP ${status}: ${desc}` : `${method} HTTP ${status}`;
}

export function createTelegramClient(token: string): TelegramClient {
  /**
   * 单次请求的响应分类（矩阵的唯一落点）。
   * 200/2xx：JSON 解析失败 → retryable；ok:true → Ok；ok:false → permanent；
   * 无 ok 字段 → retryable。
   */
  async function classify<T>(
    method: string,
    response: Response,
  ): Promise<TelegramResult<T>> {
    // 先取文本再解析：非 JSON body 一律 retryable（矩阵行）
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        ok: false,
        kind: "retryable",
        errorMessage: `${method} non-JSON response (HTTP ${response.status})`,
      };
    }

    const description = isRecord(body) ? body.description : undefined;
    const status = response.status;

    if (status === 429) {
      const parameters = isRecord(body) ? body.parameters : undefined;
      const retryAfter = isRecord(parameters)
        ? numberOf(parameters.retry_after)
        : undefined;
      return {
        ok: false,
        kind: "retryable",
        errorMessage: sanitizedMessage(method, status, description),
        ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
      };
    }
    if (status >= 500) {
      return {
        ok: false,
        kind: "retryable",
        errorMessage: sanitizedMessage(method, status, description),
      };
    }
    if (status >= 400) {
      // 400 毒丸 / 403 / 其他 4xx 一律 permanent，errorCode = HTTP 状态透传
      return {
        ok: false,
        kind: "permanent",
        errorCode: status,
        errorMessage: sanitizedMessage(method, status, description),
      };
    }
    // 2xx：按信封 ok 字段三分
    if (isRecord(body) && body.ok === true) {
      return { ok: true, result: body.result as T };
    }
    if (isRecord(body) && body.ok === false) {
      // 信封有 error_code 时透传（200 + ok:false 形态同样如此）
      const errorCode = numberOf(body.error_code);
      return {
        ok: false,
        kind: "permanent",
        ...(errorCode !== undefined ? { errorCode } : {}),
        errorMessage: sanitizedMessage(method, status, description),
      };
    }
    // 200 + 合法 JSON 但无 ok 字段 → retryable（防御：Telegram 行为漂移）
    return {
      ok: false,
      kind: "retryable",
      errorMessage: `${method} HTTP ${status}: valid JSON without ok field`,
    };
  }

  /** 单次尝试：fetch 抛出（网络错误）→ retryable，且绝不透传含 URL 的异常文本 */
  async function attempt<T>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<TelegramResult<T>> {
    let response: Response;
    try {
      response = await fetch(`${API_ORIGIN}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      return { ok: false, kind: "retryable", errorMessage: `${method} network error` };
    }
    return classify<T>(method, response);
  }

  /**
   * 全部方法共用的唯一入口：一次尝试 + 「429 且 retry_after ≤ 3s」时
   * sleep 后原地重试恰好一次。第二次的任何结果直接返回：
   * 仍 429 → retryable 携带新 retryAfterSeconds（绝不重试两次）。
   */
  async function request<T>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<TelegramResult<T>> {
    const first = await attempt<T>(method, payload);
    const retryable429 =
      !first.ok &&
      first.kind === "retryable" &&
      first.retryAfterSeconds !== undefined &&
      first.retryAfterSeconds <= IMMEDIATE_RETRY_MAX_SECONDS;
    if (!retryable429) return first;

    await sleep(first.retryAfterSeconds! * 1000);
    return attempt<T>(method, payload);
  }

  return {
    setWebhook: (params: SetWebhookParams) =>
      request<boolean>("setWebhook", {
        url: params.url,
        secret_token: params.secretToken,
        allowed_updates: params.allowedUpdates,
      }),
    deleteWebhook: () => request<boolean>("deleteWebhook", {}),
    getMe: () => request<TelegramBotUser>("getMe", {}),
    // T07 /selfcheck：读取当前 webhook 绑定状态（诊断用只读方法）。与其余
    // 方法一样只经 request() 既有分类矩阵（含 429 有界原地重试的共享行为，
    // 恰一次、绝不两次）——「单次调用不重试」由自检层保证：失败（retryable /
    // permanent 均同）只落 failed 文案，绝不再次调用
    getWebhookInfo: () => request<WebhookInfo>("getWebhookInfo", {}),
    sendMessage: (params: SendMessageParams) =>
      request<SendMessageResult>("sendMessage", { ...params }),
    forwardMessage: (params: ForwardMessageParams) =>
      request<ForwardMessageResult>("forwardMessage", { ...params }),
    copyMessage: (params: CopyMessageParams) =>
      request<CopyMessageResult>("copyMessage", { ...params }),
    createForumTopic: (params: CreateForumTopicParams) =>
      request<CreateForumTopicResult>("createForumTopic", { ...params }),
    deleteForumTopic: (params: DeleteForumTopicParams) =>
      request<boolean>("deleteForumTopic", { ...params }),
    // Telegram 原生 topic state / T38 archive：参数蛇形原样透传（与 deleteForumTopic 同款）
    closeForumTopic: (params: CloseForumTopicParams) =>
      request<boolean>("closeForumTopic", { ...params }),
    reopenForumTopic: (params: ReopenForumTopicParams) =>
      request<boolean>("reopenForumTopic", { ...params }),
    // T39 /purgemsg：按账本 group_msg_id 逐条删除（Bot API 单条接口，
    // 无批量——部分失败计数由 commands.ts 消费方汇总）
    deleteMessage: (params: DeleteMessageParams) =>
      request<boolean>("deleteMessage", { ...params }),
    // T22 媒体 per-type send：参数名即 Telegram API 字段名（photo/video/…），
    // 蛇形原样透传；caption / message_thread_id 为 undefined 时 JSON 序列化自然剔除
    sendPhoto: (params: SendPhotoParams) =>
      request<MessageIdResult>("sendPhoto", { ...params }),
    sendVideo: (params: SendVideoParams) =>
      request<MessageIdResult>("sendVideo", { ...params }),
    sendVoice: (params: SendVoiceParams) =>
      request<MessageIdResult>("sendVoice", { ...params }),
    sendAudio: (params: SendAudioParams) =>
      request<MessageIdResult>("sendAudio", { ...params }),
    sendDocument: (params: SendDocumentParams) =>
      request<MessageIdResult>("sendDocument", { ...params }),
    sendSticker: (params: SendStickerParams) =>
      request<MessageIdResult>("sendSticker", { ...params }),
    sendAnimation: (params: SendAnimationParams) =>
      request<MessageIdResult>("sendAnimation", { ...params }),
    // T24：置顶静默（disable_notification 恒 true——invariant 收敛在 client 一处）
    pinChatMessage: (params: PinChatMessageParams) =>
      request<boolean>("pinChatMessage", { ...params, disable_notification: true }),
    editMessageText: (params: EditMessageTextParams) =>
      request<MessageIdResult>("editMessageText", { ...params }),
    // T27 答题 toast：callbackQueryId 蛇形映射为 callback_query_id；
    // text 为 undefined 时 JSON 序列化自然剔除（与其余可选参数同款语义）
    answerCallbackQuery: (params: AnswerCallbackQueryParams) =>
      request<boolean>("answerCallbackQuery", {
        callback_query_id: params.callbackQueryId,
        text: params.text,
      }),
    // T34 验收增量：命令菜单注册 / 对称清理。commands 的键名（command /
    // description）即 API 字段名，scope 对象蛇形原样直传；scope 为
    // undefined 时 JSON 序列化自然剔除（= default 全局作用域）
    setMyCommands: (params: SetMyCommandsParams) =>
      request<boolean>("setMyCommands", {
        commands: params.commands,
        scope: params.scope,
      }),
    deleteMyCommands: (params: DeleteMyCommandsParams) =>
      request<boolean>("deleteMyCommands", { scope: params.scope }),
  };
}
