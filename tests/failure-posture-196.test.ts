/**
 * #196 — the failure posture of a governed check, end to end through the real
 * client and the real hook handlers (fetch is the only thing stubbed).
 *
 *   limit        HTTP 429, a V1 limit envelope (429 or 403), the back-off an
 *                earlier limit stamped            -> config.onError
 *   refused      HTTP 3xx, a 4xx other than 408 and 429 without a decision
 *                                                 -> config.onError
 *   unavailable  a network error, HTTP 408, 5xx, a 2xx that is not a decision
 *                                                 -> config.failMode
 *
 * And the invariants around it: a refusal never arms the auth breaker, a 403
 * that carries the platform's decision stays the deny, message_sending is
 * never silent under onError=allow, and one MCP session is reused for at most
 * five minutes and dropped on any error.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AxonFlowClient,
  AxonFlowHttpError,
  AxonFlowLimitError,
} from "../src/axonflow-client.js";
import {
  classifyGovernanceFailure,
  createBeforeToolCallHandler,
} from "../src/governance.js";
import { createMessageSendingHandler } from "../src/message-guard.js";
import { resetFailOpenNoticeForTests } from "../src/fail-open-notice.js";
import { resolveConfig, type AxonFlowPluginConfig } from "../src/config.js";

const ENDPOINT = "http://localhost:8080";
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function response(
  status: number,
  body: unknown,
  opts: { text?: string; headers?: Record<string, string> } = {},
) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) lower[k.toLowerCase()] = v;
  const text = opts.text ?? (body === undefined ? "" : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text)),
    headers: { get: (h: string) => lower[h.toLowerCase()] ?? null },
  };
}

function makeClient() {
  return new AxonFlowClient({
    endpoint: ENDPOINT,
    clientId: "test-client",
    clientSecret: "test-secret",
    mode: "self-hosted",
  });
}

function config(overrides: Partial<AxonFlowPluginConfig> = {}): AxonFlowPluginConfig {
  return {
    endpoint: ENDPOINT,
    clientId: "test-client",
    clientSecret: "test-secret",
    mode: "self-hosted",
    onError: "block",
    failMode: "open",
    ...overrides,
  } as AxonFlowPluginConfig;
}

function envelope(limitType: string) {
  return {
    error: "Free tier limit reached",
    limit_type: limitType,
    tier: "Free",
    limit: 25,
    remaining: 0,
    window: "minute",
    resets_at: new Date(Date.now() + 60_000).toISOString(),
    upgrade: { tier: "Pro", wording: "Free tier limit reached", buy_url: "https://example.invalid/buy" },
  };
}

let cacheDir: string;
let savedCacheDir: string | undefined;
let savedFailMode: string | undefined;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  mockFetch.mockReset();
  resetFailOpenNoticeForTests();
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axf-196-"));
  savedCacheDir = process.env.AXONFLOW_CACHE_DIR;
  process.env.AXONFLOW_CACHE_DIR = cacheDir;
  savedFailMode = process.env.AXONFLOW_FAIL_MODE;
  delete process.env.AXONFLOW_FAIL_MODE;
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  resetFailOpenNoticeForTests();
  if (savedCacheDir === undefined) delete process.env.AXONFLOW_CACHE_DIR;
  else process.env.AXONFLOW_CACHE_DIR = savedCacheDir;
  if (savedFailMode === undefined) delete process.env.AXONFLOW_FAIL_MODE;
  else process.env.AXONFLOW_FAIL_MODE = savedFailMode;
  fs.rmSync(cacheDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe("the client classifies a refused check by status (#196)", () => {
  for (const [route, call] of [
    ["check-input", (c: AxonFlowClient) => c.mcpCheckInput("openclaw.bash", "{}")],
    ["check-output", (c: AxonFlowClient) => c.mcpCheckOutput("openclaw.bash", "out")],
  ] as const) {
    describe(route, () => {
      it("a plain JSON 429 is a limit", async () => {
        mockFetch.mockResolvedValueOnce(response(429, { error: "too many requests" }));
        const err = await call(makeClient()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AxonFlowLimitError);
        expect((err as AxonFlowLimitError).status).toBe(429);
        expect((err as Error).message).toContain("too many requests");
      });

      it("a text/plain 429 (a proxy's) is a limit, not a parse failure", async () => {
        mockFetch.mockResolvedValueOnce(response(429, undefined, { text: "Too Many Requests" }));
        const err = await call(makeClient()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AxonFlowLimitError);
      });

      it("a 429 limit envelope is a limit carrying its limit_type, and stamps the back-off", async () => {
        mockFetch.mockResolvedValueOnce(response(429, envelope("per_minute"), { headers: { "Retry-After": "60" } }));
        const err = await call(makeClient()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AxonFlowLimitError);
        expect((err as AxonFlowLimitError).limitType).toBe("per_minute");
        expect(fs.existsSync(path.join(cacheDir, "throttle-until"))).toBe(true);
      });

      it("a 403 limit envelope is a limit, not a credential failure and not a deny", async () => {
        mockFetch.mockResolvedValueOnce(response(403, envelope("active_policies")));
        const err = await call(makeClient()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AxonFlowLimitError);
        expect((err as AxonFlowLimitError).status).toBe(403);
        expect((err as AxonFlowLimitError).limitType).toBe("active_policies");
      });

      it("the back-off an earlier limit stamped refuses as a limit without a request (it used to answer allowed)", async () => {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(path.join(cacheDir, "throttle-until"), `${Math.floor(Date.now() / 1000) + 600} per_minute\n`);
        const err = await call(makeClient()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AxonFlowLimitError);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it("a text/plain 403 is a refusal with its status, not a limit", async () => {
        mockFetch.mockResolvedValueOnce(response(403, undefined, { text: "Forbidden" }));
        const err = await call(makeClient()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AxonFlowHttpError);
        expect(err).not.toBeInstanceOf(AxonFlowLimitError);
        expect((err as AxonFlowHttpError).status).toBe(403);
      });

      for (const status of [301, 402, 404, 408, 413, 502, 503]) {
        it(`HTTP ${status} throws with its status`, async () => {
          mockFetch.mockResolvedValueOnce(response(status, undefined, { text: "<html>nope</html>" }));
          const err = await call(makeClient()).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(AxonFlowHttpError);
          expect((err as AxonFlowHttpError).status).toBe(status);
        });
      }

      it("a 200 that is not JSON throws with its status: no usable answer", async () => {
        mockFetch.mockResolvedValueOnce(response(200, undefined, { text: "ok" }));
        const err = await call(makeClient()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AxonFlowHttpError);
        expect((err as AxonFlowHttpError).status).toBe(200);
      });
    });
  }

  it("check-input: a 403 carrying the platform's decision is the deny (measured shape)", async () => {
    mockFetch.mockResolvedValueOnce(
      response(403, { allowed: false, block_reason: "explicit_constraint", decision_id: "d-196", policies_evaluated: 93 }),
    );
    const check = await makeClient().mcpCheckInput("openclaw.bash", "{}");
    expect(check.allowed).toBe(false);
    expect(check.block_reason).toBe("explicit_constraint");
  });
});

describe("classifyGovernanceFailure", () => {
  const cases: Array<[string, unknown, string]> = [
    ["a limit error", new AxonFlowLimitError(403, "Forbidden", {}, "x", "active_policies"), "limit"],
    ["429", new AxonFlowHttpError(429, "Too Many Requests", {}, "x"), "limit"],
    ["401", new AxonFlowHttpError(401, "Unauthorized", {}, "x"), "refused"],
    ["403", new AxonFlowHttpError(403, "Forbidden", {}, "x"), "refused"],
    ["301", new AxonFlowHttpError(301, "Moved", {}, "x"), "refused"],
    ["402", new AxonFlowHttpError(402, "Payment Required", {}, "x"), "refused"],
    ["404", new AxonFlowHttpError(404, "Not Found", {}, "x"), "refused"],
    ["413", new AxonFlowHttpError(413, "Too Large", {}, "x"), "refused"],
    ["408", new AxonFlowHttpError(408, "Timeout", {}, "x"), "unavailable"],
    ["500", new AxonFlowHttpError(500, "Error", {}, "x"), "unavailable"],
    ["503", new AxonFlowHttpError(503, "Unavailable", {}, "x"), "unavailable"],
    ["200 not JSON", new AxonFlowHttpError(200, "OK", {}, "x"), "unavailable"],
    ["a network error", new Error("fetch failed"), "unavailable"],
    ["a message-classified auth error", new Error("HTTP 401 Unauthorized"), "refused"],
  ];
  for (const [label, err, expected] of cases) {
    it(`${label} -> ${expected}`, () => {
      expect(classifyGovernanceFailure(err)).toBe(expected);
    });
  }
});

describe("before_tool_call reads the posture (real client, stubbed fetch)", () => {
  function handler(cfg: AxonFlowPluginConfig) {
    return createBeforeToolCallHandler({ current: makeClient() }, cfg);
  }

  it("a 429 under onError=block blocks, naming the limit (it used to run)", async () => {
    mockFetch.mockResolvedValueOnce(response(429, { error: "too many requests" }));
    const result = await handler(config())({ toolName: "bash", params: { command: "ls" } });
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("AxonFlow request limit reached");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("a 429 under onError=allow runs, and says so once", async () => {
    mockFetch.mockResolvedValue(response(429, { error: "too many requests" }));
    const h = handler(config({ onError: "allow" }));
    await expect(h({ toolName: "bash", params: {} })).resolves.toBeUndefined();
    await expect(h({ toolName: "bash", params: {} })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("UNGOVERNED");
  });

  it("the back-off under onError=block blocks without a request", async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "throttle-until"), `${Math.floor(Date.now() / 1000) + 600} daily_quota\n`);
    const result = await handler(config())({ toolName: "bash", params: {} });
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("request limit");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("a 404 under onError=block blocks as a refused check", async () => {
    mockFetch.mockResolvedValueOnce(response(404, undefined, { text: "404 page not found" }));
    const result = await handler(config())({ toolName: "bash", params: {} });
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("AxonFlow refused the governance check");
  });

  it("a 301 under onError=allow runs, and says so", async () => {
    mockFetch.mockResolvedValueOnce(response(301, undefined, { text: "Moved" }));
    const result = await handler(config({ onError: "allow" }))({ toolName: "bash", params: {} });
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  for (const [label, arrange] of [
    ["a 503", () => mockFetch.mockResolvedValueOnce(response(503, { error: "unavailable" }))],
    ["a 408", () => mockFetch.mockResolvedValueOnce(response(408, { error: "timeout" }))],
    ["a network error", () => mockFetch.mockRejectedValueOnce(new Error("fetch failed"))],
  ] as const) {
    it(`${label} under failMode=open runs with the notice, even with onError=block`, async () => {
      arrange();
      const result = await handler(config({ onError: "block", failMode: "open" }))({ toolName: "bash", params: {} });
      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it(`${label} under failMode=closed blocks, naming the switch`, async () => {
      arrange();
      const result = await handler(config({ onError: "allow", failMode: "closed" }))({ toolName: "bash", params: {} });
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('failMode is "closed"');
    });
  }

  it("failMode never loosens a limit or a refusal", async () => {
    mockFetch.mockResolvedValueOnce(response(429, { error: "too many requests" }));
    const limited = await handler(config({ failMode: "open" }))({ toolName: "bash", params: {} });
    expect(limited?.block).toBe(true);
    mockFetch.mockResolvedValueOnce(response(404, undefined, { text: "nope" }));
    const refused = await handler(config({ failMode: "open" }))({ toolName: "bash", params: {} });
    expect(refused?.block).toBe(true);
  });
});

describe("a refusal never arms the auth breaker (#196)", () => {
  it("a 401 identity refusal on the override read leaves check-input working", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      response(401, { error: "Authenticated user identity required (X-User-Email)" }),
    );
    await expect(client.listOverridesStrict()).rejects.toBeInstanceOf(AxonFlowHttpError);
    expect(client.isAuthFailed()).toBe(false);
    mockFetch.mockResolvedValueOnce(response(200, { allowed: true, policies_evaluated: 3 }));
    await expect(client.mcpCheckInput("openclaw.bash", "{}")).resolves.toMatchObject({ allowed: true });
  });

  it("a 401 on the agent-tools MCP server does not arm it", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      response(401, { jsonrpc: "2.0", id: "init", error: { code: -32001, message: "Authentication required" } }),
    );
    const res = await client.callMCPTool("axonflow_list_pro_features", {});
    expect(res.kind).toBe("error");
    expect(client.isAuthFailed()).toBe(false);
  });

  it("a 429, a 402 and a 403 on check-input do not arm it", async () => {
    const client = makeClient();
    for (const [status, body] of [
      [429, { error: "too many requests" }],
      [402, { error: "ERR_TIER_LIMIT_SERVICE_PRINCIPAL" }],
      [403, { error: "Forbidden" }],
    ] as const) {
      mockFetch.mockResolvedValueOnce(response(status, body));
      await client.mcpCheckInput("openclaw.bash", "{}").catch(() => undefined);
      expect(client.isAuthFailed()).toBe(false);
    }
  });

  it("a 401 on check-input, a tenant-credential route, still arms it", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(response(401, { error: "invalid client credentials" }));
    await client.mcpCheckInput("openclaw.bash", "{}").catch(() => undefined);
    expect(client.isAuthFailed()).toBe(true);
  });
});

describe("message_sending under onError=allow is never silent (#196)", () => {
  it("delivers the message and emits the notice naming the outbound message", async () => {
    mockFetch.mockResolvedValueOnce(response(503, { error: "unavailable" }));
    const h = createMessageSendingHandler({ current: makeClient() }, config({ onError: "allow" }));
    await expect(h({ to: "user", content: "hello" })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("This outbound message ran UNGOVERNED");
  });

  it("cancels under onError=block, with no notice", async () => {
    mockFetch.mockResolvedValueOnce(response(429, { error: "too many requests" }));
    const h = createMessageSendingHandler({ current: makeClient() }, config({ onError: "block" }));
    await expect(h({ to: "user", content: "hello" })).resolves.toEqual({ cancel: true });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("failMode resolution", () => {
  const base = { endpoint: ENDPOINT, clientId: "c", clientSecret: "s" };
  const cases: Array<[string, Record<string, unknown>, string | undefined, "open" | "closed"]> = [
    ["unset everywhere", {}, undefined, "open"],
    ["pluginConfig closed", { failMode: "closed" }, undefined, "closed"],
    ["pluginConfig open", { failMode: "open" }, undefined, "open"],
    ["env closed", {}, "closed", "closed"],
    ["env CLOSED", {}, "CLOSED", "closed"],
    ["env a typo", {}, "clsoed", "closed"],
    ["env open", {}, "open", "open"],
    ["env OPEN", {}, "OPEN", "open"],
    ["env empty", {}, "", "open"],
    ["pluginConfig open, env closed", { failMode: "open" }, "closed", "closed"],
    ["pluginConfig closed, env open", { failMode: "closed" }, "open", "closed"],
  ];
  for (const [label, raw, env, expected] of cases) {
    it(`${label} -> ${expected}`, () => {
      if (env === undefined) delete process.env.AXONFLOW_FAIL_MODE;
      else process.env.AXONFLOW_FAIL_MODE = env;
      expect(resolveConfig({ ...base, ...raw }).failMode).toBe(expected);
    });
  }
});

describe("one MCP session is reused for agent-tool calls (#196)", () => {
  function init(id: string) {
    return response(200, { jsonrpc: "2.0", id: "init", result: {} }, { headers: { "mcp-session-id": id } });
  }
  function ok(text: string) {
    return response(200, { jsonrpc: "2.0", id: "call", result: { content: [{ type: "text", text }] } });
  }
  function sessionHeaders(): Array<string | undefined> {
    return mockFetch.mock.calls.map(
      (c) => ((c[1] as RequestInit).headers as Record<string, string>)["mcp-session-id"],
    );
  }

  it("two calls within the cap share one session: one initialize, two tools/call", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(init("sess-1")).mockResolvedValueOnce(ok("{}")).mockResolvedValueOnce(ok("{}"));
    await client.callMCPTool("axonflow_list_pro_features", {});
    await client.callMCPTool("axonflow_list_pro_features", {});
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(sessionHeaders()).toEqual([undefined, "sess-1", "sess-1"]);
  });

  it("a session older than MCP_SESSION_MAX_AGE_MS is not reused", async () => {
    const client = makeClient();
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    mockFetch.mockResolvedValueOnce(init("sess-old")).mockResolvedValueOnce(ok("{}"));
    await client.callMCPTool("axonflow_list_pro_features", {});
    now.mockReturnValue(1_000_000 + AxonFlowClient.MCP_SESSION_MAX_AGE_MS);
    mockFetch.mockResolvedValueOnce(init("sess-new")).mockResolvedValueOnce(ok("{}"));
    await client.callMCPTool("axonflow_list_pro_features", {});
    expect(sessionHeaders()).toEqual([undefined, "sess-old", undefined, "sess-new"]);
  });

  it("a session is still reused just inside the cap", async () => {
    const client = makeClient();
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(2_000_000);
    mockFetch.mockResolvedValueOnce(init("sess-a")).mockResolvedValueOnce(ok("{}"));
    await client.callMCPTool("axonflow_list_pro_features", {});
    now.mockReturnValue(2_000_000 + AxonFlowClient.MCP_SESSION_MAX_AGE_MS - 1);
    mockFetch.mockResolvedValueOnce(ok("{}"));
    await client.callMCPTool("axonflow_list_pro_features", {});
    expect(sessionHeaders()).toEqual([undefined, "sess-a", "sess-a"]);
  });

  for (const [label, answer] of [
    ["a JSON-RPC error", () => response(200, { jsonrpc: "2.0", id: "call", error: { code: -32001, message: "Authentication required" } })],
    ["a non-JSON answer", () => response(502, undefined, { text: "<html>bad gateway</html>" })],
    ["a result without content", () => response(200, { jsonrpc: "2.0", id: "call", result: {} })],
  ] as const) {
    it(`${label} drops the session, so the next call initializes a new one`, async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(init("sess-1")).mockResolvedValueOnce(answer());
      await client.callMCPTool("axonflow_list_pro_features", {});
      mockFetch.mockResolvedValueOnce(init("sess-2")).mockResolvedValueOnce(ok("{}"));
      await client.callMCPTool("axonflow_list_pro_features", {});
      expect(sessionHeaders()).toEqual([undefined, "sess-1", undefined, "sess-2"]);
    });
  }

  it("a network error on tools/call drops the session", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(init("sess-1")).mockRejectedValueOnce(new Error("fetch failed"));
    await expect(client.callMCPTool("axonflow_list_pro_features", {})).rejects.toThrow("fetch failed");
    mockFetch.mockResolvedValueOnce(init("sess-2")).mockResolvedValueOnce(ok("{}"));
    await client.callMCPTool("axonflow_list_pro_features", {});
    expect(sessionHeaders()).toEqual([undefined, "sess-1", undefined, "sess-2"]);
  });
});
