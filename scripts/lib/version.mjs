// 版本模块的纯渲染/校验函数（T08 版本注入，2026-09-30 范围变更）。
//
// 纯度约定（与 config.mjs 相同）：本模块不得引用 process、node:fs、node:path 等
// 任何 Node 专有 API——test/version-module.test.ts 会在 workerd 沙箱（vitest
// cloudflare pool）内直接导入它，出现 Node 内置模块导入会导致测试无法加载。
// 文件读写分别在 scripts/gen-version.mjs 与 scripts/deploy.mjs 内联完成。

/**
 * 版本号安全字符集：数字、字母、.、+、-（覆盖 semver 主/次/修订号、预发布段
 * 与构建段的全部合法字符）。白名单校验保证渲染进双引号字符串字面量的内容
 * 不可能出现引号、反斜杠或换行，因此无需任何转义处理——含这些字符的"版本号"
 * 一律拒绝（真实来源 package.json 由 npm 保证是合法 semver，不会误伤）。
 *
 * @type {RegExp}
 */
const SAFE_VERSION_PATTERN = /^[0-9A-Za-z.+-]+$/;

/**
 * 校验版本号并渲染为 src/generated/version.ts 的完整内容。
 *
 * 输出形状（逐字节确定，无转义分支）：
 *   // 自动生成（scripts/gen-version.mjs，来源 package.json 的 version 字段），勿手改
 *   export const VERSION = "<version>";
 *   （末尾带一个换行符）
 *
 * @param {string} version package.json 的 version 字段
 * @returns {string} 模块文件的完整内容
 * @throws {TypeError} version 不是字符串
 * @throws {Error} version 为空，或含引号/换行等双引号字面量不安全字符
 */
export function renderVersionModule(version) {
  if (typeof version !== "string") {
    throw new TypeError("renderVersionModule：version 必须是字符串");
  }
  if (version === "" || !SAFE_VERSION_PATTERN.test(version)) {
    throw new Error(
      `版本号含非法字符（只允许数字/字母/./+/-）：${JSON.stringify(version)}`,
    );
  }
  return (
    "// 自动生成（scripts/gen-version.mjs，来源 package.json 的 version 字段），勿手改\n" +
    `export const VERSION = "${version}";\n`
  );
}
