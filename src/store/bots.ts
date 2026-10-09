/**
 * bots 表 store：bot 身份写入 / 读取。
 *
 * setwebhook 绑定时由 getMe 结果 upsert（docs/guide/database.md）；
 * webhook 处理时用 getSingleBotId 取数据归属（v1 单 bot：单行读，
 * 不从 update 猜身份——T41 原则的 v1 形态）。
 */
import { nowIso } from "./util";

export interface BotIdentity {
  botId: number;
  username: string;
  displayName: string;
}

/**
 * 写入 / 刷新 bot 身份：冲突时只更新 username / display_name，
 * created_at（首次绑定时间）保留首行值。
 */
export async function upsertBot(db: D1Database, bot: BotIdentity): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bots (bot_id, username, display_name, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (bot_id) DO UPDATE SET
         username = excluded.username,
         display_name = excluded.display_name`,
    )
    .bind(bot.botId, bot.username, bot.displayName, nowIso())
    .run();
}

/** 单行读：表空 → null（= 尚未 setwebhook，调用方按未绑定处理） */
export async function getSingleBotId(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT bot_id FROM bots LIMIT 1")
    .first<{ bot_id: number }>();
  return row?.bot_id ?? null;
}
