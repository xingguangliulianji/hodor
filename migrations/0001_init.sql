-- hodor 初始迁移：六表 DDL
-- 字段与语义唯一事实源：docs/guide/database.md
-- 全局约定：所有表带 bot_id 维度；时间戳为 ISO-8601 UTC 文本；布尔用 0/1 整数
-- 幂等由 wrangler migrations 台账保证：不写 IF NOT EXISTS，不写任何 DROP / 破坏性语句
-- 不建外键：D1 默认不启用 FK enforcement，表间关系仅为逻辑关系

-- bot 身份：setwebhook 绑定时由 getMe 自动写入 / 更新
CREATE TABLE bots (
  bot_id       INTEGER PRIMARY KEY,
  username     TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 用户档案、验证与限频状态：UNIQUE (bot_id, user_id) 由复合主键承载
CREATE TABLE users (
  bot_id            INTEGER NOT NULL,
  user_id           INTEGER NOT NULL,
  first_name        TEXT NOT NULL DEFAULT '',
  last_name         TEXT NOT NULL DEFAULT '',
  username          TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  is_banned         INTEGER NOT NULL DEFAULT 0 CHECK (is_banned IN (0,1)),
  is_risk           INTEGER NOT NULL DEFAULT 0 CHECK (is_risk IN (0,1)),
  is_verified       INTEGER NOT NULL DEFAULT 0 CHECK (is_verified IN (0,1)),
  verified_at       TEXT,
  verify_answer     INTEGER,
  verify_msg_id     INTEGER,
  rate_window_start TEXT,
  rate_count        INTEGER NOT NULL DEFAULT 0,
  last_notice_at    TEXT,
  first_seen_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (bot_id, user_id)
);

-- 用户 ↔ topic 双向映射（核心表）：
-- PK (bot_id, user_id) 承载入站正向查找；UNIQUE (bot_id, thread_id) 承载出站反查
CREATE TABLE topics (
  bot_id        INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,
  thread_id     INTEGER NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  pinned_msg_id INTEGER,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at     TEXT,
  PRIMARY KEY (bot_id, user_id)
);
CREATE UNIQUE INDEX idx_topics_bot_thread ON topics(bot_id, thread_id);

-- 消息账本：/purgemsg 与运维查询的数据来源
CREATE TABLE messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id         INTEGER NOT NULL,
  user_id        INTEGER NOT NULL,
  thread_id      INTEGER NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('in','out')),
  group_msg_id   INTEGER,
  private_msg_id INTEGER,
  content_type   TEXT NOT NULL DEFAULT 'text',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at);
CREATE INDEX idx_messages_user_created ON messages(user_id, created_at);

-- 运行时开关：命令切换需即时生效，不走 env、不重新部署
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 幂等与重试：UNIQUE (bot_id, update_id)，attempts ≥ MAX_ATTEMPTS 置 failed 跳过（防毒丸）
CREATE TABLE processed_updates (
  bot_id     INTEGER NOT NULL,
  update_id  INTEGER NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('processed','failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (bot_id, update_id)
);
