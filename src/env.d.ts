/**
 * 手工维护的环境类型合并（见 .trellis/spec/backend/env-config.md）。
 *
 * `wrangler types` 只能从 wrangler.jsonc 推导绑定类型（如 HODOR_DB），
 * 读不到 Secret 与面板变量，因此这 9 个变量在这里手工声明。
 *
 * 注意：选填变量未配置时运行时为 undefined（binding 缺席），
 * 消费方必须自行处理默认值，不得假设字段恒为字符串。
 */
declare global {
  namespace Cloudflare {
    interface Env {
      /** 【必填 Secret】Bot token，Worker → Telegram 调用凭证，永不进 URL / 日志 */
      TELEGRAM_BOT_TOKEN: string;
      /** 【必填 Secret】setWebhook 的官方 secret_token，update 回调头校验用 */
      TELEGRAM_WEBHOOK_SECRET: string;
      /** 【必填 Secret】管理端点凭证，作为 URL 路径段使用（/setwebhook/<ADMIN_SECRET>） */
      ADMIN_SECRET: string;
      /** 【必填 Var】客服超级群 chat_id（-100 开头） */
      SUPPORT_CHAT_ID: string;
      /** 【必填 Var】管理员 Telegram 用户 ID，逗号分隔 */
      ADMIN_IDS: string;
      /** 【选填 Var】每用户每分钟转发上限，缺省 20 */
      MAX_MESSAGES_PER_MINUTE?: string;
      /** 【选填 Var】验证有效期（小时），缺省 0 = 永久 */
      VERIFY_TTL_HOURS?: string;
      /** 【选填 Var】同一条 update 处理失败的最大重试次数，缺省 3 */
      MAX_ATTEMPTS?: string;
      /** 【选填 Var】自定义欢迎语文案，支持换行（字面 \n 解释为换行）；缺省用内置默认文案 */
      WELCOME_TEXT?: string;
    }
  }
}

// 使本文件成为 module，避免全局污染
export type {};
