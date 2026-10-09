// scripts/lib/version.d.mts —— scripts/lib/version.mjs 的类型声明
//
// 实现文件是零依赖纯 JS（workerd 沙箱可直接导入）；本声明让 tsc 能为
// test/version-module.test.ts 中的 `import … from "../scripts/lib/version.mjs"`
// 提供类型（TS 对 .mjs 导入按 .d.mts 查找声明），与 config.d.mts 同理。

/**
 * 校验版本号并渲染为 src/generated/version.ts 的完整内容
 * （头注释 + `export const VERSION = "<version>";` + 尾换行）。
 *
 * 版本号不是字符串抛 TypeError；为空或含引号/换行等双引号字面量
 * 不安全字符（白名单只放行数字/字母/./+/-，即 semver 全集）抛 Error。
 */
export declare function renderVersionModule(version: string): string;
