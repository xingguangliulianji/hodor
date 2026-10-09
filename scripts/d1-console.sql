-- ============================================================================
-- hodor D1 Console 运维查询包
-- ============================================================================
--
-- 用途：面向 Cloudflare D1 Console 的运维查询集合，覆盖日常排障场景：
--   总览 / 用户档案 / topic 绑定 / 消息账本 / 失败 update（毒丸）/ 配置与身份 /
--   孤儿检测，以及隔离在文件末尾「危险区」的维护语句。
--
-- 用法：Cloudflare Dashboard → Storage & Databases → D1 → hodor 数据库 → Console，
--   逐条复制下方语句粘贴执行（一次一条，注释行可不复制）。
--
-- 占位符（执行前替换）：
--   123456789 → 目标用户的 Telegram user_id
--   888       → 目标 topic 的 thread_id（即 message_thread_id，可先用「三、topic」查询定位）
--   LIMIT 50 / LIMIT 20 → 返回条数上限，可按需调整
--
-- 说明：
--   - 字段与语义的事实源：docs/guide/database.md（DDL 见 migrations/）。
--   - 所有表带 bot_id 维度（多 bot 预留）；v1 为单 bot 主线，以下查询未带
--     bot_id 过滤，多 bot 场景需自行追加 WHERE bot_id = <目标 bot>。
--   - 时间戳为 ISO-8601 UTC 文本，「今日」按 UTC 计算。
--   - 一至七为只读查询，可放心执行；「八、维护」为 DELETE，粘贴即生效。

-- ----------------------------------------------------------------------------
-- 一、总览
-- ----------------------------------------------------------------------------

-- 1.1 核心计数一览：用户 / 消息 / 今日消息 / topic / 失败 update
--     （今日消息按 UTC；失败 update 即毒丸台账，正常应接近 0）
SELECT
  (SELECT COUNT(*) FROM users)                                        AS [用户数],
  (SELECT COUNT(*) FROM topics)                                       AS [topic数],
  (SELECT COUNT(*) FROM messages)                                     AS [消息总数],
  (SELECT COUNT(*) FROM messages WHERE date(created_at) = date('now')) AS [今日消息数UTC],
  (SELECT COUNT(*) FROM processed_updates WHERE status = 'failed')    AS [失败update数];

-- ----------------------------------------------------------------------------
-- 二、用户
-- ----------------------------------------------------------------------------

-- 2.1 单用户全档案：users 全部状态列 + 该用户的 topic 绑定（LEFT JOIN，未建
--     topic 的未验证用户也能查出）。要点：status 为 active / deleted（deleted
--     表示 /archive 软归档，行仍在）；is_banned / is_risk / is_verified 为 0/1；
--     verify_answer 非空 = 有进行中的验证题；note（备注）在 topics 表。
SELECT
  u.user_id, u.first_name, u.last_name, u.username,
  u.status, u.is_banned, u.is_risk, u.is_verified, u.verified_at,
  u.verify_answer, u.verify_msg_id,
  u.rate_window_start, u.rate_count, u.last_notice_at, u.risk_notice_at,
  u.first_seen_at, u.last_seen_at,
  t.thread_id, t.title AS topic_title, t.status AS topic_status,
  t.note, t.pinned_msg_id, t.created_at AS topic_created_at, t.closed_at
FROM users u
LEFT JOIN topics t ON t.bot_id = u.bot_id AND t.user_id = u.user_id
WHERE u.user_id = 123456789;

-- 2.2 未验证用户清单：卡在验证门（含已被 /archive 软归档的用户，看 status 列区分）
SELECT
  user_id, first_name, username, status, is_banned,
  verify_answer, first_seen_at, last_seen_at
FROM users
WHERE is_verified = 0
ORDER BY first_seen_at DESC;

-- 2.3 高危用户清单：/risk 标记的用户；risk_notice_at 为 topic 内高危提醒的
--     上次发出时间（24 小时窗口，NULL = 从未提醒过）
SELECT
  user_id, first_name, username, status, is_banned,
  risk_notice_at, first_seen_at, last_seen_at
FROM users
WHERE is_risk = 1
ORDER BY last_seen_at DESC;

-- ----------------------------------------------------------------------------
-- 三、topic
-- ----------------------------------------------------------------------------

-- 3.1 用户 ↔ topic 绑定全表：入站按 user_id 正查、出站按 thread_id 反查的依据。
--     topic_status 为 open / closed（closed 由 /archive 或原生关闭消息同步）；
--     user_status 为 deleted 表示该用户已被 /archive 软归档。
SELECT
  t.thread_id, t.user_id,
  u.first_name, u.username, u.status AS user_status,
  t.title, t.status AS topic_status, t.note,
  t.pinned_msg_id, t.created_at, t.closed_at
FROM topics t
LEFT JOIN users u ON u.bot_id = t.bot_id AND u.user_id = t.user_id
ORDER BY t.thread_id;

-- 3.2 closed 归档清单：已关闭 / 归档的 topic，按关闭时间倒序
SELECT
  t.thread_id, t.user_id, t.title, t.note,
  u.status AS user_status, t.created_at, t.closed_at
FROM topics t
LEFT JOIN users u ON u.bot_id = t.bot_id AND u.user_id = t.user_id
WHERE t.status = 'closed'
ORDER BY t.closed_at DESC;

-- ----------------------------------------------------------------------------
-- 四、消息账本
-- ----------------------------------------------------------------------------

-- 4.1 按用户查最近消息：direction 为 in（用户 → 群）/ out（群 → 用户）；
--     group_msg_id / private_msg_id 分别是群内、私聊两侧的消息 ID
SELECT
  direction, content_type, group_msg_id, private_msg_id, created_at
FROM messages
WHERE user_id = 123456789
ORDER BY created_at DESC
LIMIT 50;

-- 4.2 按 topic 查最近消息：出站排障常用（在群内某 topic 看到异常，按 thread_id 查账本）
SELECT
  user_id, direction, content_type, group_msg_id, private_msg_id, created_at
FROM messages
WHERE thread_id = 888
ORDER BY created_at DESC
LIMIT 50;

-- ----------------------------------------------------------------------------
-- 五、幂等排障
-- ----------------------------------------------------------------------------

-- 5.1 失败 update 明细（毒丸排查）：attempts 达到 MAX_ATTEMPTS（env，默认 3）后
--     置 failed 跳过；created_at 为最近认领时间。配合 wrangler tail 的报错日志
--     定位失败原因；确认要重试时见「八、维护」的重置语句。
SELECT
  update_id, attempts, created_at
FROM processed_updates
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 20;

-- ----------------------------------------------------------------------------
-- 六、配置与身份
-- ----------------------------------------------------------------------------

-- 6.1 运行时开关当前值：verify_enabled（1/0）、verify_mode（math/button）；
--     行缺失或值非法时运行时回退默认（verify_enabled=1、verify_mode=math）
SELECT key, value
FROM settings;

-- 6.2 bot 身份：setwebhook 绑定时由 getMe 自动写入 / 更新
SELECT bot_id, username, display_name, created_at
FROM bots;

-- ----------------------------------------------------------------------------
-- 七、孤儿检测
-- ----------------------------------------------------------------------------

-- 7.1 无对应 users 行的 topic：正常不应出现（users 与 topics 同生共死）；
--     出现说明数据被手动改动过，可结合 3.1 全表确认影响
SELECT
  t.bot_id, t.user_id, t.thread_id, t.title, t.status, t.created_at
FROM topics t
LEFT JOIN users u ON u.bot_id = t.bot_id AND u.user_id = t.user_id
WHERE u.user_id IS NULL;

-- 7.2 无 topic 绑定的消息账本（按 thread 汇总）：有一类已知无害场景——
--     原生删除 topic 后运行时自愈只清掉旧 topics 绑定行，历史账本有意保留
--     （thread_id 悬空无害，见 docs/guide/database.md）；数量持续增长才需关注
SELECT
  m.thread_id, COUNT(*) AS message_count, MAX(m.created_at) AS last_message_at
FROM messages m
LEFT JOIN topics t ON t.bot_id = m.bot_id AND t.thread_id = m.thread_id
WHERE t.thread_id IS NULL
GROUP BY m.thread_id
ORDER BY message_count DESC;

-- 7.3 无 topic 绑定的用户：未通过验证的用户本来就没有 topic（正常）；
--     is_verified = 1 却无绑定才异常（绑定丢失会导致中继找不到目标）
SELECT
  u.user_id, u.first_name, u.username, u.status,
  u.is_verified, u.is_banned, u.first_seen_at, u.last_seen_at
FROM users u
LEFT JOIN topics t ON t.bot_id = u.bot_id AND t.user_id = u.user_id
WHERE t.user_id IS NULL
ORDER BY u.last_seen_at DESC;

-- ============================================================================
-- ============================================================================
--
--  危 险 区（八、维护）——以下全部是 DELETE 语句
--
--  · 无任何确认步骤：粘贴执行立即生效，删错只能连备份一起承担后果
--  · 日常清理优先使用 topic 内命令（带二次确认，且同步处理 Telegram 侧）：
--      /deluser     单用户删除（确认后一并删除群内对应话题）
--      /wipealldata 全清（确认后先删除群内全部话题再清库）
--  · 仅在命令不可用时（如排障、收敛半清状态）才使用本段 SQL
--
-- ============================================================================
-- ============================================================================

-- 8.1 重置失败 update（毒丸重试）
-- 警告：DELETE 语句，无确认步骤，粘贴执行立即生效。
-- 用途：清除 processed_updates 中 status='failed' 的行，让 Telegram 后续重推
--       这些 update_id 时重新处理（配合已修复的代码 / 配置使用）。
-- 影响范围：仅幂等台账的 failed 行；用户 / topic / 消息数据不受影响。
-- 执行前预演（确认命中形状）：
--   SELECT COUNT(*) FROM processed_updates WHERE status = 'failed';
DELETE FROM processed_updates WHERE status = 'failed';

-- 8.2 按用户清理（/deluser 的数据库面）
-- 警告：DELETE 语句，无确认步骤，粘贴执行立即生效；日常优先用命令 /deluser。
-- 与 /deluser 命令的差别：只清数据库行，不走 Telegram 侧——群内对应话题不会被
--   删除（需手动关闭或删除）；用户私聊窗口历史同样不在删除范围（命令也不删）。
-- 替换 123456789 为目标 user_id；顺序 messages → topics → users →（残留确认行），
--   与运行时 deleteUserData 的清理面一致。
-- 影响范围：该用户的全部消息账本、topic 绑定、用户档案、残留的二次确认行。
-- 执行前预演（确认命中形状）：
--   SELECT COUNT(*) FROM messages   WHERE user_id = 123456789;
--   SELECT COUNT(*) FROM topics     WHERE user_id = 123456789;
DELETE FROM messages            WHERE user_id = 123456789;
DELETE FROM topics              WHERE user_id = 123456789;
DELETE FROM users               WHERE user_id = 123456789;
DELETE FROM delete_confirmations WHERE user_id = 123456789;

-- 8.3 全清（/wipealldata 的数据库面）
-- 警告：全表 DELETE（无 WHERE），无确认步骤，粘贴执行立即生效；日常优先用
--       命令 /wipealldata（带两步确认）。
-- 与 /wipealldata 命令的差别：不删群内任何话题——群内会残留全部用户话题，
--   需要手动逐个处理；命令版会先删除群内全部话题（General 除外）再清库。
-- 影响范围：users / topics / messages / delete_confirmations 四表全部清空；
--   保留 settings（验证开关与模式不重置）、processed_updates（幂等台账，
--   清了会导致 Telegram 重推时重放全部历史 update，绝不可清）、bots（bot 身份）。
DELETE FROM messages;
DELETE FROM topics;
DELETE FROM users;
DELETE FROM delete_confirmations;
