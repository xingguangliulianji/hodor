-- 迁移 0003：users 表增加 risk_notice_at 列（阶段 5 T37 高危提醒窗口）
-- 字段与语义唯一事实源：docs/guide/database.md（本迁移与该文档同步更新）
--
-- 背景（design.md §二.1）：/risk 标记的高危用户来消息（通过三门后）在
-- topic 内发一次醒目提醒，同一用户 24 小时内不重复——本列即窗口起点
-- （NULL = 从未提醒，首条消息即提醒）。/risk 重新标记时由 setter 一并
-- 清空本列，实现「提示窗口重置，下一条消息再提醒一次」的 PRD 语义。
-- ALTER 加列向后兼容、不丢数据，无破坏性语句。

ALTER TABLE users ADD COLUMN risk_notice_at TEXT;
