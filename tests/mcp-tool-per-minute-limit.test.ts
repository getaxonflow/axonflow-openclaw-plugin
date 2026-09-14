/**
 * callMCPTool over the Community SaaS Free per-minute limit
 * (axonflow-enterprise#4261).
 *
 * The MCP route answers the per-minute limit as a wrapped HTTP 429: a
 * JSON-RPC result flagged isError whose text is the V1 envelope with
 * limit_type "per_minute", plus Retry-After: 60. The client must return
 * kind "envelope" (the upgrade prompt shown, a 60-second back-off stamped),
 * never kind "ok" with the envelope handed to the agent as the tool's result.
 *
 * Runtime correctness lives in runtime-e2e/free-tier-minute-limit/test.sh.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AxonFlowClient } from "../src/axonflow-client.js";
import { isThrottleActive } from "../src/upgrade-prompt.js";

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const perMinuteEnvelope = {
  error: "Rate limit exceeded (25 req/min). Try again shortly.",
  limit_type: "per_minute",
  tier: "Free",
  limit: 25,
  remaining: 0,
  window: "per_minute",
  upgrade: {
    tier: "Pro",
    wording: "Free tier allows 25 requests per minute. Pro raises this to 200.",
    compare_url: "https://getaxonflow.com/pricing/",
    buy_url: "https://example.invalid/buy",
  },
};

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
    headers: { get: (h: string) => lower[h.toLowerCase()] ?? null },
  };
}

function queueInitializeThenPerMinute429() {
  mockFetch
    .mockResolvedValueOnce(response(200, { jsonrpc: "2.0", id: "init", result: {} }, { "mcp-session-id": "sess-1" }))
    .mockResolvedValueOnce(response(429, {
      jsonrpc: "2.0",
      id: "call-axonflow_list_pro_features",
      result: { isError: true, content: [{ type: "text", text: JSON.stringify(perMinuteEnvelope) }] },
    }, { "Retry-After": "60" }));
}

function makeClient() {
  const client = new AxonFlowClient({
    endpoint: "http://localhost:8080",
    clientId: "test-client",
    clientSecret: "test-secret",
    mode: "self-hosted",
  });
  const infos: string[] = [];
  client.setUpgradePromptLogger({
    info: (m: string) => { infos.push(m); },
    warn: () => undefined,
    error: () => undefined,
  });
  return { client, infos };
}

let cacheDir: string;
let savedCacheDir: string | undefined;
beforeEach(() => {
  mockFetch.mockReset();
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axf-per-minute-"));
  savedCacheDir = process.env.AXONFLOW_CACHE_DIR;
  process.env.AXONFLOW_CACHE_DIR = cacheDir;
});
afterEach(() => {
  if (savedCacheDir === undefined) delete process.env.AXONFLOW_CACHE_DIR;
  else process.env.AXONFLOW_CACHE_DIR = savedCacheDir;
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe("callMCPTool over the Free per-minute limit", () => {
  it("returns kind envelope for the wrapped 429, with the upgrade prompt and a 60-second back-off", async () => {
    queueInitializeThenPerMinute429();
    const { client, infos } = makeClient();
    const before = Date.now();
    const res = await client.callMCPTool("axonflow_list_pro_features", {});
    expect(res.kind).toBe("envelope");
    if (res.kind === "envelope") {
      expect(res.envelope.limit_type).toBe("per_minute");
    }
    expect(infos.some((m) => m.includes("Pro raises this to 200"))).toBe(true);
    expect(infos.some((m) => m.startsWith("[AxonFlow] Upgrade: "))).toBe(true);
    // The back-off follows Retry-After (60 s), not the daily reset.
    expect(isThrottleActive(cacheDir, before + 50_000)).toBe(true);
    expect(isThrottleActive(cacheDir, before + 120_000)).toBe(false);
  });

  it("answers the next call from the back-off, without a network call", async () => {
    queueInitializeThenPerMinute429();
    const { client } = makeClient();
    await client.callMCPTool("axonflow_list_pro_features", {});
    mockFetch.mockClear();
    const next = await client.callMCPTool("axonflow_list_pro_features", {});
    expect(next.kind).toBe("throttled");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
