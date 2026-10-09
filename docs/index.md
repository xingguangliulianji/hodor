---
layout: home

hero:
  name: Hodor
  text: Telegram 双向私聊机器人
  tagline: 一个用户，一个话题，消息不串线。
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/deploy
    - theme: alt
      text: GitHub
      link: https://github.com/huaiminyetnotsleep/hodor
  image:
    src: /icon.png
    alt: Hodor 图标

features:
  - icon: 🆓
    title: 免费自部署
    details: 跑在 Cloudflare Workers + D1 免费套餐上即可运行；消息数据只经过你自己的 Worker 和数据库，不经任何第三方中转，不怕消息泄露。
  - icon: 🚀
    title: 一键部署
    details: Fork 仓库后在 Cloudflare 连接 Git 即完成部署：D1 建库、绑定、建表全自动，push 即更新；全程浏览器操作，无需本地环境。
  - icon: 🗂️
    title: 一人一话题
    details: 每个用户独占超级群组的一个 topic，消息不再堆叠、分不清来自谁；多名管理员在 topic 里直接说话即可回复，无需回复某条特定消息。
  - icon: 🤖
    title: 人机验证 + 限频
    details: 数学题 / 按钮验证码，一次验证永久有效（可配置 TTL）；每分钟消息数超限自动触发重新验证，防止 bot 刷掉 CF 免费额度。
  - icon: 🔐
    title: 隐私与安全
    details: 三种密钥各司其职，bot token 永不进 URL；图片、视频、附件全部 Telegram file_id 直传，不落盘、零存储成本。
  - icon: 🧩
    title: 平滑演进
    details: 所有数据表预留 bot 维度，多机器人、bot / 群组换绑迁移、TGuard 验证均已排期（见 TODO），v1 数据无需迁移即可升级。
---

::: warning 当前交付进度
项目按 12 阶段渐进交付。**已上线**：部署自动化、文本双向聊天（webhook 绑定 / 鉴权 / 幂等 / topic 映射）、聊天体验完善（7 类媒体直传、欢迎语、用户信息置顶、消息账本、无绑定提示）、安全试运行（数学题验证、分钟限频、提示频控、`/help` `/ban` `/unban`）。验证开关、纯按钮模式、备注与高危标记、会话清理命令按 [TODO 阶段计划](/todo/index.md)在阶段 5–6 交付——部署前请阅读各阶段使用门槛。
:::
