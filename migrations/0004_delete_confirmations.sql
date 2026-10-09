-- 阶段 6 /deluser 二次确认：取消与确认的原子裁决及失败重推收敛
-- 字段与语义唯一事实源：docs/guide/database.md
-- 幂等由 wrangler migrations 台账保证；append-only，不改旧表
CREATE TABLE delete_confirmations (
  bot_id              INTEGER NOT NULL,
  prompt_msg_id       INTEGER NOT NULL,
  user_id             INTEGER NOT NULL,
  thread_id           INTEGER NOT NULL,
  started_at          INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cancelled','confirmed')),
  confirm_callback_id TEXT,
  PRIMARY KEY (bot_id, prompt_msg_id)
);
CREATE INDEX idx_delete_confirmations_user ON delete_confirmations(bot_id, user_id);
