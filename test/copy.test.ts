/**
 * copy.ts 文案模块直测（trellis-check P2 加固，2026-09-30；阶段 5 M1 扩展）：
 *
 * - DEFAULT_WELCOME_TEXT 逐字定稿——期望值**硬编码**（不取自 copy.ts），
 *   打破「import 常量自比较」的循环断言：文案漂移（fork 改写 / 误改）即刻红灯；
 * - formatPinnedInfo 回退链三分支完整输出 + 验证行**三态**（✅ 已验证 /
 *   ❌ 未验证 / 未启用）+ 高危 / 备注行按需追加（行序固定）与
 *   `YYYY-MM-DD HH:mm (UTC)` 时间格式；
 * - isStartCommand 矩阵；阶段 4 新文案定稿（验证题 / 超限 / 禁言 / 命令）；
 * - 阶段 5（M1）：formatHelpText 开关 × 模式四态（只展示可操作开关命令 +
 *   纯按钮防护较弱说明）+ ADMIN_COMMAND_MENU 与帮助清单一致性互证 +
 *   note / risk / verifyon / verifyoff / verifymode / 纯按钮题面新文案定稿；
 * - 阶段 5（M3）：答错重试前缀（与模式化题面拼接、math 拼接产物与
 *   formatVerifyRetryQuestion 逐字一致）+ 超限纯按钮变体
 *   formatRateLimitVerifyButton（限频前缀与数学题形态一致）定稿。
 *
 * 纯函数直测，不触碰 D1 与 SELF。
 *
 * 阶段 4 调整说明：阶段 3 的「验证状态：未启用」断言按验证交付翻转为两态
 * 契约（isVerified → ✅ 已验证 / ❌ 未验证）——原断言意图（置顶绝不伪称
 * 验证状态）保留并收紧。
 * 阶段 5 调整说明：验证行两态按 T31 开关交付升为三态（verify 入参对象化，
 * 新增 disabled = 验证关闭期间恒「未启用」）；HELP_TEXT 常量改
 * formatHelpText(settings) 动态生成——既有断言意图（只列已交付命令、
 * 未交付命令绝不出现）按新形态保留。
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_COMMAND_MENU,
  BAN_NOTICE,
  DEFAULT_WELCOME_TEXT,
  formatBanConfirmed,
  formatHelpText,
  formatNoteConfirmed,
  formatPinnedInfo,
  formatRateLimitVerifyButton,
  formatRateLimitVerifyQuestion,
  formatRiskConfirmed,
  formatRiskTopicNotice,
  formatUnbanConfirmed,
  formatUnnoteConfirmed,
  formatUnriskConfirmed,
  formatVerifyButtonQuestion,
  formatVerifyModeConfirmed,
  formatVerifyOffConfirmed,
  formatVerifyOnConfirmed,
  formatVerifyQuestion,
  formatVerifyRetryQuestion,
  isStartCommand,
  NOTE_USAGE_NOTICE,
  UNBOUND_TOPIC_NOTICE,
  UNKNOWN_COMMAND_NOTICE,
  VERIFY_BUTTON_LABEL,
  VERIFY_EXPIRED_NOTICE,
  VERIFY_PASSED_TEXT,
  VERIFY_PASSED_TOAST,
  VERIFY_QUESTION_HEADER,
  VERIFY_RETRY_PREFIX,
  VERIFY_WRONG_TOAST,
} from "../src/copy";

describe("copy: DEFAULT_WELCOME_TEXT 逐字定稿", () => {
  it("三要素完整字面量（项目名 / 使用方式 / 项目地址；emoji、空行、URL 均逐字）", () => {
    // 期望值硬编码自 docs/guide/features.md 定稿文案——与 copy.ts 零共享
    expect(DEFAULT_WELCOME_TEXT).toBe(`你好，欢迎使用 hodor 私聊机器人！👋

直接发送消息即可与客服对话，无需任何命令；客服的回复也会在这里显示。

项目地址：https://github.com/huaiminyetnotsleep/hodor`);
  });
});

describe("copy: formatPinnedInfo 昵称回退链与验证行三态（完整输出断言）", () => {
  it("first + last 且有 @username：姓名（@handle）括注齐备（已验证态 ✅）", () => {
    expect(
      formatPinnedInfo({
        id: 123456789,
        first_name: "张",
        last_name: "三",
        username: "zhangsan",
        firstSeenAt: "2026-09-29T18:00:05.123Z",
        verify: "verified",
      }),
    ).toBe(
      [
        "昵称：张 三（@zhangsan）",
        "用户 ID：123456789",
        "首次聊天：2026-09-29 18:00 (UTC)",
        "验证状态：✅ 已验证",
      ].join("\n"),
    );
  });

  it("姓名无 @username：括注整体省略（不留空括号）（未验证态 ❌）", () => {
    expect(
      formatPinnedInfo({
        id: 42,
        first_name: "Alice",
        last_name: "L",
        firstSeenAt: "2020-01-01T08:05:00.000Z",
        verify: "unverified",
      }),
    ).toBe(
      [
        "昵称：Alice L",
        "用户 ID：42",
        "首次聊天：2020-01-01 08:05 (UTC)",
        "验证状态：❌ 未验证",
      ].join("\n"),
    );
  });

  it("全无名（first_name 空白同缺席）但有 @username → 展示 @username 且括注省略（不出现 @x（@x）重复）", () => {
    expect(
      formatPinnedInfo({
        id: 778,
        first_name: "   ",
        username: "bob_hd",
        firstSeenAt: "2024-12-31T23:59:59.999Z",
        verify: "unverified",
      }),
    ).toBe(
      [
        "昵称：@bob_hd",
        "用户 ID：778",
        "首次聊天：2024-12-31 23:59 (UTC)",
        "验证状态：❌ 未验证",
      ].join("\n"),
    );
  });

  it("全无名无 @username → ID_<id> 兜底（已验证态 ✅）", () => {
    expect(
      formatPinnedInfo({ id: 777, firstSeenAt: "2025-06-30T09:07:00.000Z", verify: "verified" }),
    ).toBe(
      [
        "昵称：ID_777",
        "用户 ID：777",
        "首次聊天：2025-06-30 09:07 (UTC)",
        "验证状态：✅ 已验证",
      ].join("\n"),
    );
  });

  it("任意分支恒含三态验证行之一且时间为 YYYY-MM-DD HH:mm (UTC)（秒/毫秒截断）", () => {
    const unverifiedSamples = [
      formatPinnedInfo({ id: 1, first_name: "A", username: "a", firstSeenAt: "2026-09-29T18:00:05.123Z", verify: "unverified" }),
      formatPinnedInfo({ id: 2, first_name: "B", firstSeenAt: "2026-09-29T18:00:05.123Z", verify: "unverified" }),
      formatPinnedInfo({ id: 3, username: "c", firstSeenAt: "2026-09-29T18:00:05.123Z", verify: "unverified" }),
      formatPinnedInfo({ id: 4, firstSeenAt: "2026-09-29T18:00:05.123Z", verify: "unverified" }),
    ];
    for (const text of unverifiedSamples) {
      expect(text).toContain("验证状态：❌ 未验证");
      expect(text).toMatch(/首次聊天：\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC\)/);
      // 未验证态绝不混入已验证标记（置顶绝不伪称验证状态——原意图保留）
      expect(text).not.toContain("✅");
    }
    // 已验证态：✅ 已验证（与未验证态零歧义）
    expect(
      formatPinnedInfo({ id: 5, first_name: "V", firstSeenAt: "2026-01-01T00:00:00.000Z", verify: "verified" }),
    ).toContain("验证状态：✅ 已验证");
    // 未启用态（T31 验证关闭期间）：「未启用」，不带任何状态 emoji
    const disabled = formatPinnedInfo({ id: 6, first_name: "D", firstSeenAt: "2026-01-01T00:00:00.000Z", verify: "disabled" });
    expect(disabled).toContain("验证状态：未启用");
    expect(disabled).not.toContain("✅");
    expect(disabled).not.toContain("❌");
  });

  it("高危 / 备注行按需追加（行序：验证状态 → 高危 → 备注；缺省 / 空值零痕迹）", () => {
    const base = { id: 9, first_name: "R", username: "r", firstSeenAt: "2026-10-01T00:00:00.000Z" };
    // 缺省（isRisk / note 未携带或空）→ 恒四行，无高危 / 备注痕迹
    const plain = formatPinnedInfo({ ...base, verify: "verified" });
    expect(plain.split("\n")).toHaveLength(4);
    expect(plain).not.toContain("高危");
    expect(plain).not.toContain("备注");
    const emptyNote = formatPinnedInfo({ ...base, verify: "verified", isRisk: false, note: "" });
    expect(emptyNote.split("\n")).toHaveLength(4);

    // isRisk → 「高危：⚠️ 高危用户」追加在验证行之后
    const riskOnly = formatPinnedInfo({ ...base, verify: "unverified", isRisk: true });
    expect(riskOnly.split("\n")).toEqual([
      "昵称：R（@r）",
      "用户 ID：9",
      "首次聊天：2026-10-01 00:00 (UTC)",
      "验证状态：❌ 未验证",
      "高危：⚠️ 高危用户",
    ]);

    // note 非空 → 「备注：<text>」；null 同缺省
    const noteOnly = formatPinnedInfo({ ...base, verify: "verified", note: "仅咨询退款" });
    expect(noteOnly.split("\n")).toEqual([
      "昵称：R（@r）",
      "用户 ID：9",
      "首次聊天：2026-10-01 00:00 (UTC)",
      "验证状态：✅ 已验证",
      "备注：仅咨询退款",
    ]);
    expect(formatPinnedInfo({ ...base, verify: "verified", note: null }).split("\n")).toHaveLength(4);

    // 两者齐备 → 高危在前、备注在后（行序固定，disabled 态同样适用）
    const both = formatPinnedInfo({ ...base, verify: "disabled", isRisk: true, note: "高危勿信" });
    expect(both.split("\n")).toEqual([
      "昵称：R（@r）",
      "用户 ID：9",
      "首次聊天：2026-10-01 00:00 (UTC)",
      "验证状态：未启用",
      "高危：⚠️ 高危用户",
      "备注：高危勿信",
    ]);
  });
});

describe("copy: isStartCommand 矩阵", () => {
  it("命令形态 ✓：/start、/start@bot、/start payload、/start@bot payload、尾随空白", () => {
    expect(isStartCommand("/start")).toBe(true);
    expect(isStartCommand("/start@hodor_bot")).toBe(true);
    expect(isStartCommand("/start payload")).toBe(true);
    expect(isStartCommand("/start@hodor_bot payload")).toBe(true);
    expect(isStartCommand("/start ")).toBe(true);
  });

  it("非命令形态 ✗：前缀巧合 / 其他命令 / 空串 / 缺失 / 大小写敏感", () => {
    expect(isStartCommand("/startx")).toBe(false);
    expect(isStartCommand("/help")).toBe(false);
    expect(isStartCommand("")).toBe(false);
    expect(isStartCommand(undefined)).toBe(false);
    expect(isStartCommand("/START")).toBe(false);
  });
});

describe("copy: 阶段 4 验证 / 限频文案（T27/T29）", () => {
  it("formatVerifyQuestion：题头 + 算式，题头与超限形态共用", () => {
    expect(formatVerifyQuestion("3 + 5 = ?")).toBe(`${VERIFY_QUESTION_HEADER}\n3 + 5 = ?`);
  });

  it("formatVerifyRetryQuestion：错误提示在前 + 空行 + 新题（同一消息原位重出）", () => {
    expect(formatVerifyRetryQuestion("8 - 2 = ?")).toBe(
      `回答错误，请再试一次。\n\n${VERIFY_QUESTION_HEADER}\n8 - 2 = ?`,
    );
  });

  it("formatRateLimitVerifyQuestion：文案含限频数字（验收断言点「3」）+ 新题", () => {
    const text = formatRateLimitVerifyQuestion(3, "4 + 4 = ?");
    expect(text).toContain("每分钟最多 3 条");
    expect(text).toContain(`${VERIFY_QUESTION_HEADER}\n4 + 4 = ?`);
    // 其他 limit 数值同样内插（不与 3 硬编码耦合）
    expect(formatRateLimitVerifyQuestion(20, "1 + 1 = ?")).toContain("每分钟最多 20 条");
  });

  it("toast / 编辑文案定稿（硬编码，防漂移）", () => {
    expect(VERIFY_WRONG_TOAST).toBe("回答错误，请重试。");
    expect(VERIFY_PASSED_TOAST).toBe("验证通过！");
    expect(VERIFY_PASSED_TEXT).toBe("✅ 验证通过，现在可以直接发送消息了。");
    expect(VERIFY_EXPIRED_NOTICE).toBe("题目已失效，请发送任意消息获取新题目。");
  });

  it("M3 答错重试前缀定稿：与模式化题面拼接；math 拼接产物与 formatVerifyRetryQuestion 逐字一致", () => {
    // 前缀硬编码（防漂移）——verify.ts 答错重出分支以 prefix + challenge.text 组装
    expect(VERIFY_RETRY_PREFIX).toBe("回答错误，请再试一次。\n\n");
    // math 模式拼接产物与阶段 4 定稿函数逐字一致（零行为漂移保证点）
    expect(`${VERIFY_RETRY_PREFIX}${formatVerifyQuestion("3 + 5 = ?")}`).toBe(
      formatVerifyRetryQuestion("3 + 5 = ?"),
    );
  });

  it("M3 超限纯按钮变体 formatRateLimitVerifyButton：限频前缀与数学题形态一致（含 limit 数字），题面为按钮引导文案", () => {
    const text = formatRateLimitVerifyButton(3);
    expect(text).toContain("每分钟最多 3 条");
    // 前缀与 math 超限形态共用（超限语义不随模式变化）
    const mathPrefix = formatRateLimitVerifyQuestion(3, "4 + 4 = ?").split("\n\n")[0];
    expect(text.split("\n\n")[0]).toBe(mathPrefix);
    // 后半为纯按钮题面（copy 单点复用）
    expect(text.split("\n\n")[1]).toBe(formatVerifyButtonQuestion());
    expect(formatRateLimitVerifyButton(20)).toContain("每分钟最多 20 条");
  });
});

describe("copy: 阶段 4 封禁与命令文案（T34/T35）", () => {
  it("BAN_NOTICE 定稿：明确告知禁言且不留绕过暗示", () => {
    expect(BAN_NOTICE).toBe("你已被禁言，消息无法送达客服。如有疑问请通过其他方式联系。");
  });

  it("UNKNOWN_COMMAND_NOTICE 引导 /help", () => {
    expect(UNKNOWN_COMMAND_NOTICE).toBe("未知命令，发送 /help 查看可用命令。");
  });

  it("ban / unban 确认携带目标用户 ID", () => {
    expect(formatBanConfirmed(7117077829)).toBe("已禁言用户 7117077829：其后续消息将被拦截。");
    expect(formatUnbanConfirmed(7117077829)).toBe("已解除用户 7117077829 的禁言。");
  });

  it("UNBOUND_TOPIC_NOTICE 定稿不变（/ban /unban /note /risk 无绑定复用）", () => {
    expect(UNBOUND_TOPIC_NOTICE).toBe(
      "找不到对应用户：此话题没有有效绑定（可能从未建立或已被关闭），请勿在此继续回复。",
    );
  });
});

describe("copy: formatHelpText 动态帮助（T32，开关 × 模式四态）", () => {
  it("固定命令段：全部已交付命令 + 「/ 开头不中继」说明；未交付命令绝不出现", () => {
    for (const settings of [
      { verifyEnabled: true, verifyMode: "math" as const },
      { verifyEnabled: true, verifyMode: "button" as const },
      { verifyEnabled: false, verifyMode: "math" as const },
      { verifyEnabled: false, verifyMode: "button" as const },
    ]) {
      const text = formatHelpText(settings);
      for (const command of [
        "/help", "/ban", "/unban", "/note", "/unnote", "/risk", "/unrisk", "/verifymode",
        "/archive", "/deluser", "/purgemsg", "/wipealldata",
      ]) {
        expect(text).toContain(command);
      }
      expect(text).toContain("不会中继");
      expect(text).toContain("纯按钮模式防护较弱"); // 弱防护说明恒展示
      expect(text).toContain("不可恢复"); // 危险操作段保留警示
    }
  });

  it("开关两态只展示可操作的那个：开 → /verifyoff；关 → /verifyon + 「当前验证已关闭」", () => {
    const on = formatHelpText({ verifyEnabled: true, verifyMode: "math" });
    expect(on).toContain("/verifyoff - 临时关闭人机验证（已验证记录保留）");
    expect(on).not.toContain("/verifyon");

    const off = formatHelpText({ verifyEnabled: false, verifyMode: "math" });
    expect(off).toContain("/verifyon - 开启人机验证");
    expect(off).toContain("当前验证已关闭");
    expect(off).not.toContain("/verifyoff");
  });

  it("模式两态：/verifymode 行展示当前模式中文名（数学题 / 纯按钮）", () => {
    expect(formatHelpText({ verifyEnabled: true, verifyMode: "math" })).toContain(
      "/verifymode - 切换验证模式（当前：数学题）",
    );
    expect(formatHelpText({ verifyEnabled: false, verifyMode: "button" })).toContain(
      "/verifymode - 切换验证模式（当前：纯按钮）",
    );
  });

  it("ADMIN_COMMAND_MENU 与帮助清单一致（单一事实源互证）：帮助中的命令 = 菜单 − 不可操作开关", () => {
    // 菜单恒全量注册（Telegram 菜单是客户端缓存）；帮助只展示可操作的开关命令
    const menuCommands = ADMIN_COMMAND_MENU.map((entry) => entry.command);
    expect(menuCommands).toEqual([
      "help", "ban", "unban", "note", "unnote", "risk", "unrisk",
      "verifyon", "verifyoff", "verifymode",
      "archive", "deluser", "purgemsg", "wipealldata",
    ]);

    for (const settings of [
      { verifyEnabled: true, verifyMode: "math" as const },
      { verifyEnabled: true, verifyMode: "button" as const },
      { verifyEnabled: false, verifyMode: "math" as const },
      { verifyEnabled: false, verifyMode: "button" as const },
    ]) {
      const listed = [...formatHelpText(settings).matchAll(/^\/([a-z]+)/gm)].map((m) => m[1]);
      const hiddenToggle = settings.verifyEnabled ? "verifyon" : "verifyoff";
      expect([...listed].sort()).toEqual([...menuCommands.filter((c) => c !== hiddenToggle)].sort());
    }
  });
});

describe("copy: 阶段 5 新文案定稿（T36/T37/T31/T32）", () => {
  it("note / unnote：确认回显备注 / 清除确认 / 用法提示", () => {
    expect(formatNoteConfirmed("仅咨询退款")).toContain("仅咨询退款");
    expect(formatUnnoteConfirmed()).toContain("备注");
    expect(NOTE_USAGE_NOTICE).toContain("/note");
    expect(NOTE_USAGE_NOTICE).toContain("<内容>");
  });

  it("risk / unrisk：确认携带目标用户 ID；高危提醒醒目（⚠️ 前后缀 + 展示名）", () => {
    expect(formatRiskConfirmed(7117077829)).toContain("7117077829");
    expect(formatRiskConfirmed(7117077829)).toContain("24 小时");
    expect(formatUnriskConfirmed(7117077829)).toContain("7117077829");

    const notice = formatRiskTopicNotice("张三");
    expect(notice).toContain("⚠️");
    expect(notice).toContain("张三");
    expect(notice.startsWith("⚠️")).toBe(true); // 醒目措辞：⚠️ 开头
    // 提醒是管理员侧消息——文案绝不发给用户私聊由管线保证，此处只定稿形态
  });

  it("verifyon / verifyoff 确认：分别含「已验证不受影响」与「记录保留 + 重开判定」说明", () => {
    const onText = formatVerifyOnConfirmed();
    expect(onText).toContain("已开启");
    expect(onText).toContain("不受影响");

    const offText = formatVerifyOffConfirmed();
    expect(offText).toContain("已临时关闭");
    expect(offText).toContain("保留");
    expect(offText).toContain("有效期");
  });

  it("verifymode 确认：携带新模式；纯按钮附防护较弱说明、数学题不附", () => {
    const mathText = formatVerifyModeConfirmed("math");
    expect(mathText).toContain("数学题");
    expect(mathText).not.toContain("防护较弱");

    const buttonText = formatVerifyModeConfirmed("button");
    expect(buttonText).toContain("纯按钮");
    expect(buttonText).toContain("防护较弱");
  });

  it("纯按钮题面与按钮文案定稿", () => {
    const question = formatVerifyButtonQuestion();
    expect(question).toContain("点击下方按钮");
    expect(question).toContain("机器人");
    expect(VERIFY_BUTTON_LABEL).toBe("我不是机器人");
  });
});
