/**
 * settings 表 store：验证开关与验证模式（阶段 5 T31/T32）。
 *
 * settings 是全局单份的运行时开关（多 bot 维度拆分属阶段 8，本阶段契约
 * 即全局；docs/guide/database.md）。存库而非环境变量的产品语义是「命令
 * 切换即时生效、重部署不丢」——因此**不做缓存**：每条入站消息直读
 * （两条 PK 点查，D1 主键查询廉价），缓存会引入失效窗口破坏即时性。
 *
 * 契约：读侧行缺失 / 值非法一律回默认（verifyEnabled: true / verifyMode:
 * "math"）——与阶段 4 行为严格一致，未写过 settings 的存量部署零感知
 * （验证门恒开 + 数学题模式）；写侧 UPSERT 幂等（重复执行同值无害，
 * 重推安全）。
 */

/** 验证配置（/verifymode 翻转、验证门与动态帮助的统一数据源） */
export interface VerificationSettings {
  /** 验证门总开关（settings.verify_enabled = "1"/"0"） */
  verifyEnabled: boolean;
  /** 验证模式（settings.verify_mode = "math"/"button"） */
  verifyMode: "math" | "button";
}

/** 读单个 settings 键（PK 点查）；行缺失 → null */
async function readSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/**
 * 读取验证配置（/verifymode 翻转、验证门与动态帮助的统一数据源）。
 *
 * settings.value 是 TEXT 且无 CHECK 兜底——按「先解析、不轻信输入」逐键判定：
 * verify_enabled 仅 "1"/"0" 有效、verify_mode 仅 "math"/"button" 有效，
 * 其余（缺失 / 脏值）各键独立回默认。
 */
export async function getVerificationSettings(db: D1Database): Promise<VerificationSettings> {
  const [enabledRaw, modeRaw] = await Promise.all([
    readSetting(db, "verify_enabled"),
    readSetting(db, "verify_mode"),
  ]);
  return {
    verifyEnabled: enabledRaw === "1" ? true : enabledRaw === "0" ? false : true,
    verifyMode: modeRaw === "math" || modeRaw === "button" ? modeRaw : "math",
  };
}

/**
 * 写验证开关（/verifyon /verifyoff 的唯一写入口）：
 * "1"/"0" 布尔编码（database.md 全局约定）。
 */
export async function setVerificationEnabled(
  db: D1Database,
  enabled: boolean,
): Promise<void> {
  await upsertSetting(db, "verify_enabled", enabled ? "1" : "0");
}

/** 写验证模式（/verifymode 的唯一写入口）："math"/"button" */
export async function setVerificationMode(
  db: D1Database,
  mode: "math" | "button",
): Promise<void> {
  await upsertSetting(db, "verify_mode", mode);
}

/** settings 单键 UPSERT：无行插入、有行覆写（幂等，重推安全） */
async function upsertSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
}
