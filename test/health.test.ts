// /health 响应形状 + 404 约定（T04；T08 起附带 version）
// 本文件不触碰数据库，无需应用迁移。
// VERSION 从 ../src/generated/version 导入——与 worker 运行时（health.ts）用的
// 是同一模块：该文件由 pretest 钩子（scripts/gen-version.mjs）生成，生成器只从
// package.json 取值，因此「version === package.json version」由构造保证。
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/generated/version";

describe("GET /health", () => {
  it("返回 200，body 严格等于 {\"status\":\"ok\",\"version\":…}", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ status: "ok", version: VERSION }));
  });

  it("POST /health → 404（仅接受 GET）", async () => {
    const res = await SELF.fetch("https://example.com/health", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("未知路径 → 404", async () => {
    const res = await SELF.fetch("https://example.com/nope");
    expect(res.status).toBe(404);
  });
});
