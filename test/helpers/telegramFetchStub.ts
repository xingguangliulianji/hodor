/**
 * api.telegram.org 出站请求测试桩（shared by telegram-client / admin-endpoints 测试）。
 *
 * 背景：`fetchMock` 在 @cloudflare/vitest-pool-workers 0.13（Vitest 4 迁移）中已被
 * 移除，官方替代是直接替换 `globalThis.fetch`（本池的 main worker 与测试跑在
 * 同一 isolate/context，全局替换对 SELF.fetch 触发的出站调用同样生效——
 * cloudflare:test 类型声明原文"runs in the same isolate/context as tests"）。
 *
 * 安全保证：替换后的 fetch 对任何非 api.telegram.org 的 URL、任何未注册
 * responder 的方法一律抛错——测试内绝不可能发出真实网络请求。
 * 务必在 afterEach 中调用 restore()，避免桩泄漏到其他用例。
 */

/** 单次响应：json 会被 JSON.stringify 为 body；rawBody 优先（非 JSON 场景）；throwError 模拟网络错误 */
export interface StubResponse {
  status?: number;
  json?: unknown;
  rawBody?: string;
  throwError?: boolean;
}

export interface StubbedCall {
  /** 完整请求 URL（含 token，仅供桩内匹配；断言密钥不泄漏时不要外抛） */
  url: string;
  /** 解析出的 Telegram API 方法名（URL 末段） */
  apiMethod: string;
  /** HTTP 方法 */
  httpMethod: string;
  /** 请求 body（已 JSON.parse；无法解析时保留原始字符串） */
  body: unknown;
}

export interface TelegramFetchStub {
  /** 注册某 API 方法的响应器（callIndex 从 0 起，按该方法被调用的次数递增；
   *  响应器可异步——竞态类用例需要在请求「进行中」写 D1，D1 只有异步 API） */
  on(
    apiMethod: string,
    respond: (callIndex: number) => StubResponse | Promise<StubResponse>,
  ): void;
  /** 固定响应（等价于 on 的忽略 callIndex） */
  always(apiMethod: string, response: StubResponse): void;
  /** 该 API 方法被调用的次数 */
  countOf(apiMethod: string): number;
  /** 该 API 方法的全部调用（含 body），按时间序 */
  callsOf(apiMethod: string): StubbedCall[];
  /** 恢复原始 fetch（afterEach 必调） */
  restore(): void;
}

export function stubTelegramFetch(): TelegramFetchStub {
  const originalFetch = globalThis.fetch;
  const allCalls: StubbedCall[] = [];
  const responders = new Map<
    string,
    (callIndex: number) => StubResponse | Promise<StubResponse>
  >();
  const counters = new Map<string, number>();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const match = url.match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/([A-Za-z]+)$/);
    if (!match) {
      // 绝不放行未知 URL：测试内不允许任何真实网络请求
      throw new Error("telegramFetchStub: unexpected outbound fetch (non-Telegram URL)");
    }
    const [, apiMethod] = match;
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // 保留原始字符串
      }
    }
    allCalls.push({
      url,
      apiMethod,
      httpMethod: init?.method ?? "GET",
      body,
    });

    const respond = responders.get(apiMethod);
    if (!respond) {
      throw new Error(`telegramFetchStub: no responder registered for ${apiMethod}`);
    }
    const callIndex = counters.get(apiMethod) ?? 0;
    counters.set(apiMethod, callIndex + 1);
    const response = await respond(callIndex);
    if (response.throwError) {
      throw new Error("telegramFetchStub: simulated network failure");
    }
    const responseBody =
      response.rawBody !== undefined
        ? response.rawBody
        : JSON.stringify(response.json ?? { ok: true, result: true });
    return new Response(responseBody, {
      status: response.status ?? 200,
      headers: { "content-type": response.rawBody !== undefined ? "text/plain" : "application/json" },
    });
  }) as typeof fetch;

  return {
    on(apiMethod, respond) {
      responders.set(apiMethod, respond);
    },
    always(apiMethod, response) {
      responders.set(apiMethod, () => response);
    },
    countOf(apiMethod) {
      return allCalls.filter((call) => call.apiMethod === apiMethod).length;
    },
    callsOf(apiMethod) {
      return allCalls.filter((call) => call.apiMethod === apiMethod);
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}
