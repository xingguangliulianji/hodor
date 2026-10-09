/**
 * TelegramResult 三态契约 —— 流水线代码唯一的错误语言
 * （逐字执行 .trellis/spec/backend/error-handling.md）。
 *
 * HTTP/JSON 细节的分类只发生在 src/telegram/client.ts 的 request() 内部；
 * 消费方（pipeline / 路由）永远看不到状态码——只根据 kind 分支。
 * 本文件只定义形状，不含任何分类逻辑。
 */

/** 成功：Telegram 信封 200 + ok:true，result 直接透传 */
export type TelegramOk<T> = { ok: true; result: T };

/**
 * 失败：
 * - retryable —— 网络错误 / 5xx / 非 JSON / 429 等待过久：
 *   让请求失败（5xx），交给 Telegram 重投递 + processed_updates 状态机重试
 * - permanent —— 400（毒丸）/ 403 / 200+ok:false 等：
 *   按数字码分支处理，绝不重试
 */
export type TelegramError = {
  ok: false;
  kind: "retryable" | "permanent";
  /** 概要文本（已消毒：只含方法名 / 状态 / 信封 description，绝不含 token） */
  errorMessage?: string;
  /** 429 场景服务端指示的等待秒数 */
  retryAfterSeconds?: number;
  /** permanent 携带：信封 error_code 或 HTTP 状态码透传，消费方按数字码分支 */
  errorCode?: number;
};

export type TelegramResult<T> = TelegramOk<T> | TelegramError;

/* ------------------------------------------------------------------ */
/* 本阶段（阶段 2 MVP）所需的 6 个 API 方法的入参 / 出参最小类型子集 */
/* ------------------------------------------------------------------ */

/** getMe 返回的 bot 身份（字段按 Telegram User 信封蛇形命名） */
export interface TelegramBotUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

/** setWebhook 入参（方法名驼峰，client 内映射为 secret_token / allowed_updates） */
export interface SetWebhookParams {
  /** webhook 回调地址，= 请求 origin + /webhook（由调用方拼好） */
  url: string;
  /** 注册到 Telegram 的 secret_token（TELEGRAM_WEBHOOK_SECRET） */
  secretToken: string;
  /** 只订阅的 update 类型；阶段 4 验证码回调无需重新绑定 */
  allowedUpdates: string[];
}

/** copyMessage 入参（与 Telegram API 参数一一对应）
 *  （阶段 2 管线已不调用：copyMessage 在生产 bot 上全场景 400
 *  「message to copy not found」，2026-09-30 实测；T22 / 阶段 3 重审媒体路径） */
export interface CopyMessageParams {
  from_chat_id: number;
  from_message_id: number;
  chat_id: number;
  /** 入站带 thread（转发进 topic）；出站私聊不传 */
  message_thread_id?: number;
}

/** copyMessage 出参：新消息 ID */
export interface CopyMessageResult {
  message_id: number;
}

/** inline 键盘按钮：text 为按钮展示，callback_data 为点击回传载荷（验证题 "v:<值>"） */
export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/**
 * reply_markup 最小子集：inline 键盘（T27 验证题选项按钮）。
 * 纯透传字段（可选）——既有调用不携带时零影响。
 */
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/** sendMessage 入参：阶段 2 文本中继的实际通道 */
export interface SendMessageParams {
  chat_id: number;
  /** 纯文本内容（阶段 2 仅中继 message.text 非空） */
  text: string;
  /** 入站带 thread（送达客服群 topic）；出站私聊不传 */
  message_thread_id?: number;
  /** inline 键盘（T27 验证题按钮）；中继等既有路径不传 */
  reply_markup?: InlineKeyboardMarkup;
}

/** sendMessage 出参：新消息 ID */
export interface SendMessageResult {
  message_id: number;
}

/** forwardMessage 入参：注意参数名是 message_id（不是 copyMessage 的 from_message_id）。
 *  当前管线未调用（2026-09-30 定稿：入站文本用 sendMessage 干净渲染）——
 *  保留备用，T22 媒体阶段的「带身份」备选；生产实测支持 message_thread_id。 */
export interface ForwardMessageParams {
  chat_id: number;
  from_chat_id: number;
  message_id: number;
  /** 转发落进客服群对应 topic；2026-09-30 生产实测支持 */
  message_thread_id?: number;
}

/** forwardMessage 出参：新消息 ID */
export interface ForwardMessageResult {
  message_id: number;
}

/** createForumTopic 入参 */
export interface CreateForumTopicParams {
  chat_id: number;
  /** topic 标题：first_name → @username → ID_<user_id> 三级回退（调用方定死） */
  name: string;
}

/** createForumTopic 出参：新 topic 的 thread ID */
export interface CreateForumTopicResult {
  message_thread_id: number;
}

/** deleteForumTopic 入参 */
export interface DeleteForumTopicParams {
  chat_id: number;
  message_thread_id: number;
}

/* ------------------------------------------------------------------ */
/* 阶段 6（T38–T39）：topic 开关 + 消息删除                              */
/* ------------------------------------------------------------------ */

/** closeForumTopic 入参（原生 topic 状态同步 / T38 archive 软归档） */
export interface CloseForumTopicParams {
  chat_id: number;
  message_thread_id: number;
}

/**
 * reopenForumTopic 入参（T38 重开链路：closed 行复用前真重开——阶段 6 起
 * 原生 close / /archive 真关闭 TG topic，仅改 DB 状态不再够用）
 */
export interface ReopenForumTopicParams {
  chat_id: number;
  message_thread_id: number;
}

/** deleteMessage 入参（T39 /purgemsg：按账本 group_msg_id 逐条删除） */
export interface DeleteMessageParams {
  chat_id: number;
  message_id: number;
}

/* ------------------------------------------------------------------ */
/* T22 / T24（阶段 3）：媒体 per-type send + 置顶/编辑 8 方法          */
/* ------------------------------------------------------------------ */

/** 统一出参最小子集：send* / editMessageText 只取新消息 ID（复用同一形状） */
export interface MessageIdResult {
  message_id: number;
}

/**
 * 媒体 send* 入参公共形状：`{ chat_id, <字段>: file_id, caption?, message_thread_id? }`。
 * file_id 按字符串原样直传（不下载、不落盘——docs/guide/architecture.md 决策）；
 * 入站带 thread（落客服群 topic），出站私聊不传。
 * sticker 不可能携带 caption，其入参类型单独省略该字段。
 */
export interface SendPhotoParams {
  chat_id: number;
  photo: string;
  caption?: string;
  message_thread_id?: number;
}

export interface SendVideoParams {
  chat_id: number;
  video: string;
  caption?: string;
  message_thread_id?: number;
}

export interface SendVoiceParams {
  chat_id: number;
  voice: string;
  caption?: string;
  message_thread_id?: number;
}

/** 音频（音乐文件）：2026-09-30 真机验收按用户要求纳入支持集；title/performer 元数据不透传 */
export interface SendAudioParams {
  chat_id: number;
  audio: string;
  caption?: string;
  message_thread_id?: number;
}

export interface SendDocumentParams {
  chat_id: number;
  document: string;
  caption?: string;
  message_thread_id?: number;
}

export interface SendStickerParams {
  chat_id: number;
  sticker: string;
  message_thread_id?: number;
}

export interface SendAnimationParams {
  chat_id: number;
  animation: string;
  caption?: string;
  message_thread_id?: number;
}

/** pinChatMessage 入参；disable_notification 恒为 true（client 固定注入：置顶不弹通知） */
export interface PinChatMessageParams {
  chat_id: number;
  message_id: number;
}

/** editMessageText 入参：T24 昵称变更刷新置顶信息 / T27 验证题重出与通过提示用 */
export interface EditMessageTextParams {
  chat_id: number;
  message_id: number;
  text: string;
  /** inline 键盘（T27 答错重出新题的按钮）；刷新置顶等既有路径不传 */
  reply_markup?: InlineKeyboardMarkup;
}

/**
 * answerCallbackQuery 入参（T27）：终止客户端按钮加载态 + 可选 toast 提示。
 * callbackQueryId 即 update.callback_query.id（Telegram 单次消费）。
 */
export interface AnswerCallbackQueryParams {
  callbackQueryId: string;
  /** 弹给用户的短提示（答对 / 答错 / 题目失效）；缺省只终止加载态 */
  text?: string;
}

/* ------------------------------------------------------------------ */
/* T34 验收增量：命令菜单（setMyCommands / deleteMyCommands）           */
/* ------------------------------------------------------------------ */

/**
 * BotCommandScope 最小子集（HTTP 直传对象，蛇形键原样）：本仓库恒用
 * `{ type: "chat", chat_id: SUPPORT_CHAT_ID }` 把命令菜单限定在客服群——
 * 绝不污染用户私聊的命令菜单。
 */
export interface BotCommandScopeRef {
  type: string;
  chat_id?: number;
}

/** setMyCommands 入参：commands 键名即 Telegram API 字段名（command 无斜杠小写） */
export interface SetMyCommandsParams {
  commands: { command: string; description: string }[];
  /** 作用域（缺省 = default 全局作用域；本仓库恒携带 chat scope） */
  scope?: BotCommandScopeRef;
}

/** deleteMyCommands 入参：与注册对称，同 scope 清理 */
export interface DeleteMyCommandsParams {
  scope?: BotCommandScopeRef;
}

/* ------------------------------------------------------------------ */
/* T07（阶段 7）：getWebhookInfo —— /selfcheck 完整自检                  */
/* ------------------------------------------------------------------ */

/**
 * getWebhookInfo 返回的最小子集（/selfcheck 诊断只需要三个字段）：
 * url 为空串 = 未绑定 webhook；last_error_message 是 Telegram 记录的
 * 最近一次 webhook 投递错误原文（非密钥、本身就是排障信息，可直接回显）。
 */
export interface WebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_message?: string;
}

/** client 工厂返回的方法集（全部经 request() 分类，无一旁路） */
export interface TelegramClient {
  setWebhook(params: SetWebhookParams): Promise<TelegramResult<boolean>>;
  deleteWebhook(): Promise<TelegramResult<boolean>>;
  getMe(): Promise<TelegramResult<TelegramBotUser>>;
  getWebhookInfo(): Promise<TelegramResult<WebhookInfo>>;
  sendMessage(params: SendMessageParams): Promise<TelegramResult<SendMessageResult>>;
  forwardMessage(
    params: ForwardMessageParams,
  ): Promise<TelegramResult<ForwardMessageResult>>;
  copyMessage(params: CopyMessageParams): Promise<TelegramResult<CopyMessageResult>>;
  createForumTopic(
    params: CreateForumTopicParams,
  ): Promise<TelegramResult<CreateForumTopicResult>>;
  deleteForumTopic(params: DeleteForumTopicParams): Promise<TelegramResult<boolean>>;
  closeForumTopic(params: CloseForumTopicParams): Promise<TelegramResult<boolean>>;
  reopenForumTopic(params: ReopenForumTopicParams): Promise<TelegramResult<boolean>>;
  deleteMessage(params: DeleteMessageParams): Promise<TelegramResult<boolean>>;
  sendPhoto(params: SendPhotoParams): Promise<TelegramResult<MessageIdResult>>;
  sendVideo(params: SendVideoParams): Promise<TelegramResult<MessageIdResult>>;
  sendVoice(params: SendVoiceParams): Promise<TelegramResult<MessageIdResult>>;
  sendAudio(params: SendAudioParams): Promise<TelegramResult<MessageIdResult>>;
  sendDocument(params: SendDocumentParams): Promise<TelegramResult<MessageIdResult>>;
  sendSticker(params: SendStickerParams): Promise<TelegramResult<MessageIdResult>>;
  sendAnimation(params: SendAnimationParams): Promise<TelegramResult<MessageIdResult>>;
  pinChatMessage(params: PinChatMessageParams): Promise<TelegramResult<boolean>>;
  editMessageText(params: EditMessageTextParams): Promise<TelegramResult<MessageIdResult>>;
  answerCallbackQuery(
    params: AnswerCallbackQueryParams,
  ): Promise<TelegramResult<boolean>>;
  setMyCommands(params: SetMyCommandsParams): Promise<TelegramResult<boolean>>;
  deleteMyCommands(params: DeleteMyCommandsParams): Promise<TelegramResult<boolean>>;
}
