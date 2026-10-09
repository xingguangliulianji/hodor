// wrangler JSONC 配置的纯函数工具集 + postinstall 门控判定（T05/T06 提前交付
// 与 --install-hook 门控注入，2026-09-30 范围变更）。
//
// 纯度约定（重要）：本模块不得引用 process、node:fs、node:child_process 等
// 任何 Node 专有 API——test/deploy-config.test.ts 会在 workerd 沙箱（vitest
// cloudflare pool）内直接导入它，出现 Node 内置模块导入会导致测试无法加载。
// 路径推导、进程编排等一律放在 scripts/deploy.mjs。

/**
 * 仓库 wrangler.jsonc 中 d1_databases[0].database_id 的常驻占位符。
 *
 * 真实数据库 uuid 只允许写入 .wrangler/resolved.wrangler.jsonc（已 gitignore），
 * 仓库内的 wrangler.jsonc 永远保持占位符（fork 用户不能带上部署者的真实 id）。
 *
 * @type {string}
 */
export const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";

// 认证/权限类失败特征（isAuthFailure 对 wrangler 报错文本做分类用）。
// 「api token / oauth token」同时匹配下划线变体（CLOUDFLARE_API_TOKEN）。
const AUTH_FAILURE_PATTERN =
  /authentic|unauthori[sz]ed|not authorized|forbidden|\b403\b|api[ _]token|oauth[ _]token|not logged in|wrangler login/i;

/**
 * 判断一段 wrangler 报错文本是否属于认证/权限类失败。
 *
 * 匹配 403 / authentication / not authorized / (api|oauth)[_]token 等形态；
 * 7404 / not found 等「资源不存在」不属于认证失败——2026-09-30 生产事故的
 * 教训：`d1 info` 按配置占位 uuid 查询返回 7404，曾被旧分类逻辑含糊地归为
 * 「疑似认证或权限不足」，误导排障方向。分类必须只认认证形态本身。
 *
 * @param {string} text wrangler 输出文本（stdout/stderr 合并）
 * @returns {boolean} 是否认证/权限类失败
 */
export function isAuthFailure(text) {
  return typeof text === "string" && AUTH_FAILURE_PATTERN.test(text);
}

/**
 * 剥离 JSONC 文本中的行注释与块注释，返回可被 JSON.parse 直接解析的文本。
 *
 * 实现为单趟扫描状态机（code / lineComment / blockComment 三态 + 字符串内
 * 转义处理），而不是正则替换——正则无法可靠区分「注释定界符」与「字符串
 * 字面量内部的注释形序列」（如 URL 中的 //、或包含块注释定界符的值），会被
 * 一并误删。字符串字面量整体逐字透传；注释被移除时保留换行符，使
 * JSON.parse 的报错行号与原文一致。
 *
 * 注意：不支持 JSONC 的尾随逗号（仓库 wrangler.jsonc 也不使用）。
 *
 * @param {string} text JSONC 原文
 * @returns {string} 剥离注释后的 JSON 文本
 */
export function stripJsoncComments(text) {
  if (typeof text !== "string") {
    throw new TypeError("stripJsoncComments：text 必须是字符串");
  }
  let result = "";
  let state = "code";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : "";
    if (state === "code") {
      if (ch === '"') {
        // 字符串字面量：整体逐字透传（内部可能含 //、块注释定界符、转义序列）
        result += ch;
        i += 1;
        let escaped = false;
        while (i < n) {
          const c = text[i];
          result += c;
          i += 1;
          if (escaped) {
            escaped = false;
          } else if (c === "\\") {
            escaped = true;
          } else if (c === '"') {
            break;
          }
        }
      } else if (ch === "/" && next === "/") {
        state = "lineComment";
        i += 2;
      } else if (ch === "/" && next === "*") {
        state = "blockComment";
        i += 2;
      } else {
        result += ch;
        i += 1;
      }
    } else if (state === "lineComment") {
      // 丢弃注释内容，保留换行（维持行号），遇行尾回到 code 态
      if (ch === "\n") {
        result += "\n";
        state = "code";
      }
      i += 1;
    } else {
      // blockComment：跳到闭合定界符；内部换行同样保留以维持行号
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
      } else {
        if (ch === "\n") {
          result += "\n";
        }
        i += 1;
      }
    }
  }
  return result;
}

/**
 * 解析 wrangler 配置文本（JSONC）为对象：先剥离注释，再 JSON.parse。
 *
 * @param {string} text wrangler 配置原文（支持行注释与块注释）
 * @returns {any} 解析后的配置对象（形状由 wrangler 配置决定，此处不做结构校验）
 * @throws {Error} 文本不是合法 JSONC（错误信息附带 JSON.parse 的原始原因）
 */
export function parseWranglerConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsoncComments(text));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`wrangler 配置解析失败（不是合法 JSONC）：${reason}`);
  }
  return parsed;
}

/**
 * 将 keyPath 字符串（如 "main"、"d1_databases[0].database_id"）解析为段数组。
 * 属性名为字符串、数组下标为数字，供与扫描器算出的路径逐段比较。
 *
 * @param {string} keyPath 目标路径
 * @returns {Array<string | number>} 路径段
 */
function parseKeyPath(keyPath) {
  if (typeof keyPath !== "string" || keyPath.length === 0) {
    throw new TypeError("parseKeyPath：keyPath 必须是非空字符串");
  }
  const segments = [];
  for (const raw of keyPath.split(".")) {
    const match = /^([^[.\]]+)((?:\[\d+\])*)$/.exec(raw);
    if (match === null) {
      throw new Error(`非法 keyPath：${keyPath}`);
    }
    segments.push(match[1]);
    for (const index of raw.slice(match[1].length).match(/\[\d+\]/g) ?? []) {
      segments.push(Number(index.slice(1, -1)));
    }
  }
  return segments;
}

/**
 * 逐段比较两个路径是否相同。
 *
 * @param {Array<string | number>} a
 * @param {Array<string | number>} b
 * @returns {boolean}
 */
function pathEquals(a, b) {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

/**
 * 解析字符串字面量内容；字面量非法（如未闭合）时原样返回。
 *
 * @param {string} literal
 * @returns {string}
 */
function safeJsonParse(literal) {
  try {
    return JSON.parse(literal);
  } catch {
    return literal;
  }
}

/**
 * 在已解析的配置对象上按路径段取值；路径不通返回 undefined。
 *
 * @param {any} value
 * @param {Array<string | number>} segments
 * @returns {any}
 */
function readPath(value, segments) {
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * 在原始 JSONC 文本中定位 keyPath 指向的字符串值字面量的字符区间（含两侧引号）。
 *
 * 单趟扫描：与 stripJsoncComments 相同的注释/字符串状态机，同时维护对象/数组
 * 帧栈，为每个「值位置的字符串」计算其配置路径（如 d1_databases[0].database_id），
 * 命中目标路径即返回该字面量的原文区间。找不到（键不存在或值不是字符串）返回
 * null。注释与字符串内的注释形序列都不会造成误判。
 *
 * @param {string} text JSONC 原文
 * @param {Array<string | number>} target 解析后的目标路径段
 * @returns {{ start: number, end: number } | null} 字面量区间（含引号）
 */
function findStringRange(text, target) {
  /** @type {Array<{ kind: "object" | "array", key: string | null, index: number, path: Array<string | number> }>} */
  const stack = [];
  let state = "code";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : "";
    if (state === "code") {
      if (ch === '"') {
        const start = i;
        let j = i + 1;
        let escaped = false;
        while (j < n) {
          const c = text[j];
          if (escaped) {
            escaped = false;
          } else if (c === "\\") {
            escaped = true;
          } else if (c === '"') {
            break;
          }
          j += 1;
        }
        const end = Math.min(j + 1, n); // 含收尾引号（未闭合则到文本末尾）
        const frame = stack[stack.length - 1];
        if (frame !== undefined && frame.kind === "object" && frame.key === null) {
          // 键位置的字符串：解码其内容（转义不影响字符区间定位）
          frame.key = safeJsonParse(text.slice(start, end));
        } else if (frame !== undefined && frame.kind === "object") {
          // 值位置的字符串：路径命中目标即返回字面量区间
          if (pathEquals([...frame.path, frame.key], target)) {
            return { start, end };
          }
        }
        i = end;
      } else if (ch === "/" && next === "/") {
        state = "lineComment";
        i += 2;
      } else if (ch === "/" && next === "*") {
        state = "blockComment";
        i += 2;
      } else if (ch === "{" || ch === "[") {
        const parent = stack[stack.length - 1];
        const framePath =
          parent === undefined
            ? []
            : [...parent.path, parent.kind === "object" ? parent.key : parent.index];
        stack.push({
          kind: ch === "{" ? "object" : "array",
          key: null,
          index: 0,
          path: framePath,
        });
        i += 1;
      } else if (ch === "}" || ch === "]") {
        stack.pop();
        i += 1;
      } else if (ch === ",") {
        const frame = stack[stack.length - 1];
        if (frame !== undefined) {
          if (frame.kind === "object") {
            frame.key = null;
          } else {
            frame.index += 1;
          }
        }
        i += 1;
      } else {
        i += 1;
      }
    } else if (state === "lineComment") {
      if (ch === "\n") {
        state = "code";
      }
      i += 1;
    } else {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
      } else {
        i += 1;
      }
    }
  }
  return null;
}

/**
 * 将 JSONC 文本中 keyPath 指向的字符串值替换为 value，其余原文逐字保留。
 *
 * 只做「定位字面量区间 → 切片拼接」的原地替换，不反序列化再序列化整个文件，
 * 因此注释、字段顺序、空白全部保持原样。旧值是占位符还是真实 id 均可替换
 * （只看键是否存在，不看旧值内容）。
 *
 * @param {string} text JSONC 原文
 * @param {string} keyPath 目标路径，如 "main" 或 "d1_databases[0].database_id"
 * @param {string} value 新值（自动做 JSON 字符串转义与加引号）
 * @returns {string} 替换后的文本
 * @throws {Error} keyPath 在配置中不存在，或其值不是带引号的字符串字面量
 */
export function replaceJsoncString(text, keyPath, value) {
  if (typeof text !== "string") {
    throw new TypeError("replaceJsoncString：text 必须是字符串");
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("replaceJsoncString：value 必须是非空字符串");
  }
  const target = parseKeyPath(keyPath);
  const range = findStringRange(text, target);
  if (range === null) {
    // 区分「键不存在」与「值不是字符串字面量」两种失败，给出可定位的错误
    let parsed;
    try {
      parsed = parseWranglerConfig(text);
    } catch {
      throw new Error(`配置不是合法 JSONC，无法定位 ${keyPath}`);
    }
    if (readPath(parsed, target) !== undefined) {
      throw new Error(`${keyPath} 的值不是带引号的字符串字面量，无法原地替换`);
    }
    throw new Error(`配置中未找到 ${keyPath}，无法替换`);
  }
  return text.slice(0, range.start) + JSON.stringify(value) + text.slice(range.end);
}

/**
 * 将 wrangler 配置中 d1_databases[0].database_id 的值替换为 uuid。
 *
 * 直接在原文上做区间替换：注释与其余字段逐字保留；旧值是占位符还是真实 id
 * 都同样适用。仓库 wrangler.jsonc 永不改写——本函数的返回值只用于生成
 * .wrangler/ 下的临时 resolved 配置。
 *
 * @param {string} text wrangler 配置原文
 * @param {string} uuid 数据库 uuid（来自 wrangler d1 list / d1 create 或 D1_DATABASE_ID）
 * @returns {string} 替换后的配置文本
 * @throws {Error} 配置缺少 d1_databases[0].database_id，或其值不是字符串字面量
 */
export function withDatabaseId(text, uuid) {
  return replaceJsoncString(text, "d1_databases[0].database_id", uuid);
}

/**
 * 判断 postinstall 预置钩子（scripts/deploy.mjs --install-hook）是否应执行。
 *
 * 依据官方文档（developers.cloudflare.com/workers/ci-cd/builds/configuration/）：
 * Cloudflare Workers Builds 的构建环境固定注入 WORKERS_CI=1（同时还有 CI=true
 * 与 WORKERS_CI_BUILD_UUID / COMMIT_SHA / BRANCH 等构建元数据），官方建议用
 * WORKERS_CI 区分 Workers Builds 与本地。GitHub Actions 等其他 CI 只注入
 * CI=true 而没有 WORKERS_CI——它们绝不能触发远端 D1 查询/创建/迁移等账号级
 * 操作（本地 npm install 更是如此）。
 *
 * 因此仅当 WORKERS_CI 严格等于字符串 "1" 才返回 true；未设置、空串、"0"、
 * "true" 或任何其他取值（包括同时设置了 CI=true 的一切非 Workers Builds
 * 环境）一律返回 false。
 *
 * @param {Record<string, string | undefined>} env 环境变量快照（如 process.env）
 * @returns {boolean} 是否处于 Workers Builds 构建环境
 */
export function shouldRunInstallHook(env) {
  return env.WORKERS_CI === "1";
}
