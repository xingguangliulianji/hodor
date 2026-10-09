/**
 * settings 表 store（阶段 5 T31/T32）：getVerificationSettings 默认值
 * （无行 / 值非法逐键回默认——与阶段 4 行为严格一致，存量部署零感知）
 * + set 往返 + UPSERT 覆写幂等。
 * 文件级隔离 D1（vitest-pool-workers，applyD1Migrations 全量）。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getVerificationSettings,
  setVerificationEnabled,
  setVerificationMode,
} from "../src/store/settings";

beforeAll(async () => {
  await applyD1Migrations(env.HODOR_DB, env.TEST_MIGRATIONS);
});

/** 直读 settings 单键（测试视角独立于 store 实现） */
const readSetting = (key: string) =>
  env.HODOR_DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>()
    .then((row) => row?.value ?? null);

describe("store: getVerificationSettings 默认值", () => {
  it("两键均无行 → 默认 { verifyEnabled: true, verifyMode: 'math' }（阶段 4 行为）", async () => {
    expect(await getVerificationSettings(env.HODOR_DB)).toEqual({
      verifyEnabled: true,
      verifyMode: "math",
    });
  });

  it("verify_enabled 值非法（非 '1'/'0'）→ 该键回默认 true，不误判为关闭", async () => {
    await env.HODOR_DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('verify_enabled', 'yes')",
    ).run();
    expect((await getVerificationSettings(env.HODOR_DB)).verifyEnabled).toBe(true);
  });

  it("verify_mode 值非法（非 'math'/'button'）→ 该键回默认 math", async () => {
    await env.HODOR_DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('verify_mode', 'TGuard')",
    ).run();
    expect((await getVerificationSettings(env.HODOR_DB)).verifyMode).toBe("math");
  });

  it("两键各自独立回默认（一键合法不掩盖另一键非法）", async () => {
    // 覆写为合法值组合前，先清掉上面的脏行再各写一合法一非法
    await env.HODOR_DB.prepare("DELETE FROM settings").run();
    await env.HODOR_DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('verify_enabled', 'bogus'), ('verify_mode', 'button')",
    ).run();
    expect(await getVerificationSettings(env.HODOR_DB)).toEqual({
      verifyEnabled: true, // 非法回默认
      verifyMode: "button", // 合法保留
    });
  });
});

describe("store: set 往返与 UPSERT 覆写", () => {
  it("setVerificationEnabled：true → '1' / false → '0'，get 读回同值", async () => {
    await setVerificationEnabled(env.HODOR_DB, false);
    expect(await readSetting("verify_enabled")).toBe("0");
    expect((await getVerificationSettings(env.HODOR_DB)).verifyEnabled).toBe(false);

    await setVerificationEnabled(env.HODOR_DB, true);
    expect(await readSetting("verify_enabled")).toBe("1");
    expect((await getVerificationSettings(env.HODOR_DB)).verifyEnabled).toBe(true);
  });

  it("setVerificationMode：math / button 落库，get 读回同值", async () => {
    await setVerificationMode(env.HODOR_DB, "button");
    expect(await readSetting("verify_mode")).toBe("button");
    expect((await getVerificationSettings(env.HODOR_DB)).verifyMode).toBe("button");

    await setVerificationMode(env.HODOR_DB, "math");
    expect(await readSetting("verify_mode")).toBe("math");
    expect((await getVerificationSettings(env.HODOR_DB)).verifyMode).toBe("math");
  });

  it("UPSERT 覆写：既有行 UPDATE 而非 INSERT 冲突；重复执行同值幂等（重推安全）", async () => {
    // 人工预置行（模拟另一条 setter 已写入 / 手工运维值）——先清再插，
    // 保证进入本用例时是「既有行」形态（前序用例已写过该键）
    await env.HODOR_DB.prepare("DELETE FROM settings WHERE key = 'verify_enabled'").run();
    await env.HODOR_DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('verify_enabled', '1')",
    ).run();
    await setVerificationEnabled(env.HODOR_DB, false); // ON CONFLICT 覆写，不撞 PK
    expect(await readSetting("verify_enabled")).toBe("0");
    // settings 表始终只有这两键（UPSERT 不产生重复行）
    const { results } = await env.HODOR_DB.prepare(
      "SELECT key FROM settings ORDER BY key",
    ).all<{ key: string }>();
    const keys = results.map((row) => row.key);
    expect(keys).toContain("verify_enabled");
    expect(keys.filter((key) => key === "verify_enabled")).toHaveLength(1);

    await setVerificationEnabled(env.HODOR_DB, false); // 幂等
    expect(await readSetting("verify_enabled")).toBe("0");
  });
});
