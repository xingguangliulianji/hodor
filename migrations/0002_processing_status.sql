-- 迁移 0002：processed_updates.status 增加 'processing'（认领占位）
-- 字段与语义唯一事实源：docs/guide/database.md（本迁移与该文档同步更新）
--
-- 背景（design.md 决策表）：幂等采用「认领状态机」——并发同 id 必须原子占位，
-- 占位不是标记 processed，不违反 p1.md「成功后才标记」的警示。
-- SQLite 不能 ALTER 修改 CHECK 约束，只能整表重建。本库无外键、无触发器、
-- 无依赖该表的视图，标准 12 步可安全精简为：建新表 → INSERT SELECT 保数据
-- → DROP 旧表 → RENAME。注意：DROP 是本迁移获批设计（design.md「迁移 0002」）
-- 的一部分，不是对 0001 头部「不写破坏性语句」约定的违反——数据在 DROP 前
-- 已全量迁入新表，wrangler migrations 台账保证本迁移只执行一次。
--
-- created_at 语义同步更新：最近认领时间（每次重试 / 过期接管刷新），
-- 超过 60s 的 processing 行视为崩溃残留，可被下一次重推接管。

CREATE TABLE processed_updates_new (
  bot_id     INTEGER NOT NULL,
  update_id  INTEGER NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('processing','processed','failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (bot_id, update_id)
);

-- 全字段保数据迁入（既有行均为 processed/failed 终态，直接保留）
INSERT INTO processed_updates_new (bot_id, update_id, status, attempts, created_at)
SELECT bot_id, update_id, status, attempts, created_at FROM processed_updates;

DROP TABLE processed_updates;

ALTER TABLE processed_updates_new RENAME TO processed_updates;
