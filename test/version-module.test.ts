// scripts/lib/version.mjs 纯函数单元测试（T08 版本注入）
// 只测渲染与校验，不触碰 fs；被 import 的 version.mjs 是纯模块（无 process /
// node:* 引用），可安全运行在 workerd 沙箱（vitest cloudflare pool）内。
// 注意：不能 import scripts/gen-version.mjs——它在顶层引 node:fs，workerd
// 加载即失败；入口脚本的文件写行为由 pretest 钩子在每次 npm test 前实际执行。
import { describe, expect, it } from "vitest";
import { renderVersionModule } from "../scripts/lib/version.mjs";

describe("renderVersionModule", () => {
  it("渲染出完整模块内容：头注释 + 精确的 export 语句 + 尾换行", () => {
    expect(renderVersionModule("1.2.3")).toBe(
      "// 自动生成（scripts/gen-version.mjs，来源 package.json 的 version 字段），勿手改\n" +
        'export const VERSION = "1.2.3";\n',
    );
  });

  it("头注释标明自动生成与勿手改（防止误编辑生成物）", () => {
    const content = renderVersionModule("0.1.0");
    expect(content).toContain("自动生成");
    expect(content).toContain("勿手改");
  });

  it("semver 预发布/构建段同样合法（字符集全集）", () => {
    expect(renderVersionModule("1.0.0-beta.1")).toContain(
      'export const VERSION = "1.0.0-beta.1";',
    );
    expect(renderVersionModule("2.0.0+build.5")).toContain(
      'export const VERSION = "2.0.0+build.5";',
    );
  });

  it("版本号含引号 → 抛错（拒绝渲染可能破坏字面量的内容）", () => {
    expect(() => renderVersionModule('1.0.0"')).toThrow(/非法字符/);
    expect(() => renderVersionModule("1.0.'0'")).toThrow(/非法字符/);
    expect(() => renderVersionModule("1.0.0\\")).toThrow(/非法字符/);
  });

  it("版本号含换行 → 抛错", () => {
    expect(() => renderVersionModule("1.0.0\n")).toThrow(/非法字符/);
    expect(() => renderVersionModule("1.0.\r0")).toThrow(/非法字符/);
  });

  it("空字符串 / 非字符串 → 抛错", () => {
    expect(() => renderVersionModule("")).toThrow(/非法字符/);
    expect(() => renderVersionModule(1 as unknown as string)).toThrow(TypeError);
  });
});
