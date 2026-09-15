/**
 * callMCPTool over the Community SaaS Free per-minute limit
 * (axonflow-enterprise#4261), on both of the limit's paths.
 *
 * callMCPTool runs `initialize` and then `tools/call`, so the limit can answer
 * on either request. #4261 answers both the same way: HTTP 429,
 * Retry-After: 60, and a JSON-RPC result flagged isError whose text is the V1
 * envelope with limit_type "per_minute" and window "minute":
 *   - the pre-credential path: `initialize` itself is refused (no session is
 *     created, so there is no Mcp-Session-Id), tier "" and limit 200;
 *   - the tier-check path: `initialize` succeeds and `tools/call` is refused
 *     by the Free tier's check, tier "Free" and limit 25.
 * On both, the client must return kind "envelope" (the upgrade prompt shown,
 * a back-off stamped to the minute): never kind "ok" with the envelope handed
 * to the agent as the tool's result, and never a bare transport error.
 *
 * A bare (unwrapped) envelope is tolerated too, through detectEnvelope, whose
 * own tests cover it; #4261 does not send one, so it is not asserted here.
 *
 * Runtime correctness lives in runtime-e2e/free-tier-minute-limit/test.sh.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AxonFlowClient } from "../src/axonflow-client.js";
import { isThrottleActive, TOOL_THROTTLE_FILE } from "../src/upgrade-prompt.js";

// An agent tool's limit is stamped in the agent-tool back-off only; it never
// gates a governed tool call (#196).
const toolBackOff = { file: TOOL_THROTTLE_FILE };

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const PRICING = "https://getaxonflow.com/pricing/";
const BUY = "https://buy.stripe.com/bJe28qbztcdVchjdkw8k800";

function perMinuteEnvelope(tier: string, limit: number, wording: string, now: number) {
  return {
    error: wording,
    limit_type: "per_minute",
    tier,
    limit,
    remaining: 0,
    window: "minute",
    resets_at: new Date(Math.floor(now / 1000) * 1000 + 60_000).toISOString().replace(".000Z", "Z"),
    upgrade: { tier: "Pro", wording, compare_url: PRICING, buy_url: BUY },
  };
}

// The pre-credential check's envelope: the tier is not resolved yet.
const preCredentialEnvelope = (now: number) =>
  perMinuteEnvelope("", 200, "Per-minute limit reached (200 requests). Try again in a minute.", now);
// The Free tier's check on tools/call.
const tierCheckEnvelope = (now: number) =>
  perMinuteEnvelope("Free", 25, "Per-minute limit reached on Free tier (25 requests). Pro raises this to 200/min. Try again in a minute.", now);

function wrapped(id: string, envelope: unknown) {
  return {
    id,
    jsonrpc: "2.0",
    result: { content: [{ text: JSON.stringify(envelope, null, 2), type: "text" }], isError: true },
  };
}

const LIMIT_HEADERS = {
  "Content-Type": "application/json",
  "Retry-After": "60",
  "X-Axonflow-Tier-Limit": "per_minute",
  "X-Axonflow-Upgrade-URL": PRICING,
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

function queueTierCheck429(now: number) {
  mockFetch
    .mockResolvedValueOnce(response(200, { jsonrpc: "2.0", id: "init", result: {} }, { "mcp-session-id": "sess-1" }))
    .mockResolvedValueOnce(response(429, wrapped("call-axonflow_list_pro_features", tierCheckEnvelope(now)), LIMIT_HEADERS));
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
  it("pre-credential path (initialize answered 429, per_minute, no session): kind envelope with the upgrade prompt, not a bare transport error, and no tools/call sent", async () => {
    const now = Date.now();
    mockFetch.mockResolvedValueOnce(response(429, wrapped("init", preCredentialEnvelope(now)), LIMIT_HEADERS));
    const { client, infos } = makeClient();
    const res = await client.callMCPTool("axonflow_list_pro_features", {});
    expect(res.kind).toBe("envelope");
    if (res.kind === "envelope") {
      expect(res.envelope.limit_type).toBe("per_minute");
      expect(res.envelope.limit).toBe(200);
    }
    expect(infos.some((m) => m.includes("Per-minute limit reached (200 requests)"))).toBe(true);
    expect(infos.some((m) => m.startsWith("[AxonFlow] Upgrade: "))).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(isThrottleActive(cacheDir, now + 50_000, toolBackOff)).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, "throttle-until"))).toBe(false);
  });

  it("tier-check path (tools/call answered 429 by the Free tier's check): kind envelope, not ok, with the upgrade prompt and a back-off to the minute", async () => {
    const now = Date.now();
    queueTierCheck429(now);
    const { client, infos } = makeClient();
    const res = await client.callMCPTool("axonflow_list_pro_features", {});
    expect(res.kind).toBe("envelope");
    if (res.kind === "envelope") {
      expect(res.envelope.limit_type).toBe("per_minute");
      expect(res.envelope.tier).toBe("Free");
    }
    expect(infos.some((m) => m.includes("Pro raises this to 200/min"))).toBe(true);
    expect(infos.some((m) => m.startsWith("[AxonFlow] Upgrade: "))).toBe(true);
    // The back-off ends with the minute (resets_at, 60 s out), not at the daily reset.
    expect(isThrottleActive(cacheDir, now + 50_000, toolBackOff)).toBe(true);
    expect(isThrottleActive(cacheDir, now + 120_000, toolBackOff)).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, "throttle-until"))).toBe(false);
  });

  it("tier-check path: the next call is answered from the back-off, without a network call", async () => {
    queueTierCheck429(Date.now());
    const { client } = makeClient();
    await client.callMCPTool("axonflow_list_pro_features", {});
    mockFetch.mockClear();
    const next = await client.callMCPTool("axonflow_list_pro_features", {});
    expect(next.kind).toBe("throttled");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
