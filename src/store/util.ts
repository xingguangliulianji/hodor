/**
 * store 层共享工具。
 *
 * 时间戳全局约定（docs/guide/database.md）：ISO-8601 UTC 文本。
 * JS `toISOString()` 输出 `YYYY-MM-DDTHH:mm:ss.sssZ`，与迁移默认值
 * `strftime('%Y-%m-%dT%H:%M:%fZ','now')` 同构——两者可直接做字典序比较
 * （processed_updates 的过期接管窗口依赖这一点）。
 */

/** 当前时间的 ISO-8601 UTC 文本（毫秒精度，与 D1 默认值同构） */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 毫秒偏移前的时间 ISO 文本（负数偏移即未来时间） */
export function isoBefore(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}
