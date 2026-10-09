// scripts/lib/config.d.mts —— scripts/lib/config.mjs 的类型声明
//
// 实现文件是零依赖纯 JS（workerd 沙箱可直接导入）；本声明让 tsc 能为
// test/deploy-config.test.ts 中的 `import … from "../scripts/lib/config.mjs"`
// 提供类型（TS 对 .mjs 导入按 .d.mts 查找声明）。

/** 仓库 wrangler.jsonc 中 d1_databases[0].database_id 的常驻占位符。 */
export declare const PLACEHOLDER_DATABASE_ID: string;

/**
 * 判断 wrangler 报错文本是否属于认证/权限类失败（匹配 403 / authentication /
 * not authorized / (api|oauth)[_]token 等形态）。7404 / not found 等「资源
 * 不存在」不属于认证失败。
 */
export declare function isAuthFailure(text: string): boolean;

/**
 * 剥离 JSONC 文本中的行注释与块注释，返回可被 JSON.parse 直接解析的文本。
 * 字符串字面量（含其内部的注释形序列）逐字保留。
 */
export declare function stripJsoncComments(text: string): string;

/**
 * 解析 wrangler 配置文本（JSONC）为对象：先剥离注释，再 JSON.parse。
 * 失败抛出带原始原因的描述性错误。
 */
// 返回 any：配置对象形状由 wrangler 决定，调用方自行收窄
export declare function parseWranglerConfig(text: string): any;

/**
 * 将 d1_databases[0].database_id 的值替换为 uuid，其余原文（含注释）逐字保留。
 * 键缺失或值不是字符串字面量时抛错。
 */
export declare function withDatabaseId(text: string, uuid: string): string;

/**
 * 将 keyPath（如 "main"、"d1_databases[0].migrations_dir"）指向的字符串值
 * 替换为 value，其余原文逐字保留。键缺失或值不是字符串字面量时抛错。
 */
export declare function replaceJsoncString(
  text: string,
  keyPath: string,
  value: string,
): string;

/**
 * postinstall 预置钩子门控（--install-hook）：仅当 env.WORKERS_CI 严格等于
 * "1"（Cloudflare Workers Builds 注入）时返回 true；未设置或任何其他取值
 * （含仅有 CI=true 的 GitHub Actions 等环境）返回 false。
 */
export declare function shouldRunInstallHook(
  env: Record<string, string | undefined>,
): boolean;
