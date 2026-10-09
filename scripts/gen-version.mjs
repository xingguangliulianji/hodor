#!/usr/bin/env node
// scripts/gen-version.mjs —— 版本注入入口（T08 版本注入，2026-09-30 范围变更）
//
// 从仓库根 package.json 读取 version，生成 src/generated/version.ts：
//   - 生成目录 src/generated/ 已 gitignore——版本唯一来源是 package.json；
//   - 内容与现存文件一致则不写（保 mtime，不打扰构建缓存与文件观察器）；
//   - 纯渲染/校验在 scripts/lib/version.mjs（无 node:* 导入，workerd 沙箱可导
//     入）；本文件只做文件读写，import 无副作用（invokedAsEntry 守卫）。
//
// 调用方：npm 钩子 predev / pretest / pretypecheck、显式别名 npm run
// version:gen；CF Workers Builds 走 npm run deploy，由 scripts/deploy.mjs 在
// 迁移/部署前另行调用同一渲染函数。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderVersionModule } from "./lib/version.mjs";

// 供需要纯函数的调用方直接 import 本入口（会连带加载 node:fs，仅限 Node 侧）
export { renderVersionModule } from "./lib/version.mjs";

// —— 路径常量：全部基于 import.meta.url 推导，与进程 cwd 无关 ——
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");
const VERSION_MODULE_PATH = path.join(REPO_ROOT, "src", "generated", "version.ts");

/**
 * 读取 package.json 的 version 字段；文件不可读或字段缺失返回 undefined。
 *
 * @returns {string | undefined}
 */
function readPackageVersion() {
  try {
    const version = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")).version;
    return typeof version === "string" && version !== "" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 主流程：读版本 → 渲染 → 内容相同则跳过写入，否则写出（含建目录）。
 * 成功时只输出一行中文日志并以退出码 0 结束。
 */
function main() {
  const version = readPackageVersion();
  if (version === undefined) {
    console.error(`[version] 无法从 ${PACKAGE_JSON_PATH} 读取可用的 version 字段。`);
    process.exit(1);
  }

  let content;
  try {
    content = renderVersionModule(version);
  } catch (error) {
    console.error(
      `[version] package.json 版本号非法（${version}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }

  if (existsSync(VERSION_MODULE_PATH) && readFileSync(VERSION_MODULE_PATH, "utf8") === content) {
    console.log(`[version] 已是最新 src/generated/version.ts @ ${version}`);
    return;
  }
  mkdirSync(path.dirname(VERSION_MODULE_PATH), { recursive: true });
  writeFileSync(VERSION_MODULE_PATH, content, "utf8");
  console.log(`[version] 已生成 src/generated/version.ts @ ${version}`);
}

/**
 * 仅当本文件被 node 直接作为入口执行时才运行 main（import 无副作用）。
 * 与 deploy.mjs 相同的守卫方式：npm run 传入的 process.argv[1] 是相对路径，
 * 需 path.resolve 后再与 import.meta.url 的绝对路径比较。
 */
function invokedAsEntry() {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return path.resolve(process.argv[1]) === SCRIPT_PATH;
  } catch {
    return false;
  }
}

if (invokedAsEntry()) {
  main();
}
