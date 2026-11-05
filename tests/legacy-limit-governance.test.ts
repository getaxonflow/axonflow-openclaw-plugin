import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AxonFlowClient } from "../src/axonflow-client.js";
import type { AxonFlowPluginConfig } from "../src/config.js";
import { createBeforeToolCallHandler } from "../src/governance.js";
import { createMessageSendingHandler } from "../src/message-guard.js";
import { stampThrottle } from "../src/upgrade-prompt.js";

const baseConfig: AxonFlowPluginConfig = {
  endpoint: "https://try.getaxonflow.com",
  clientId: "linked-test",
  clientSecret: "test-secret",
  mode: "community-saas",
  onError: "block",
};

const legacyLimit = {
  error: "Free tier limit reached",
  limit_type: "feature_pro_only",
  tier: "Free",
  limit: 0,
  remaining: 0,
  resets_at: "2099-12-31T23:59:59Z",
  upgrade: {
    tier: "Pro",
    wording: "Upgrade to use this feature",
    compare_url: "https://getaxonflow.com/pricing/",
    buy_url: "https://buy.stripe.com/example",
  },
};

describe("legacy limit envelopes cannot bypass governance", () => {
  const originalFetch = globalThis.fetch;
  const priorCacheDir = process.env["AXONFLOW_CACHE_DIR"];
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axonflow-limit-governance-"));
    process.env["AXONFLOW_CACHE_DIR"] = cacheDir;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(cacheDir, { recursive: true, force: true });
    if (priorCacheDir === undefined) delete process.env["AXONFLOW_CACHE_DIR"];
    else process.env["AXONFLOW_CACHE_DIR"] = priorCacheDir;
  });

  it("checks tool policy and outbound content after an unrelated feature limit", async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(legacyLimit), { status: 429 }))
      .mockResolvedValueOnce(Response.json({ allowed: false, block_reason: "policy denied", policies_evaluated: 1 }))
      .mockResolvedValueOnce(Response.json({ allowed: false, block_reason: "PII denied", policies_evaluated: 1 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new AxonFlowClient(baseConfig);

    expect(await client.listRecentDecisionsStrict()).toMatchObject({ kind: "envelope" });
    expect(fs.existsSync(path.join(cacheDir, "throttle-until"))).toBe(true);

    const tool = createBeforeToolCallHandler({ current: client }, baseConfig);
    expect(await tool({ toolName: "web_fetch", params: { url: "https://example.com" } }))
      .toMatchObject({ block: true, blockReason: "policy denied" });
    const message = createMessageSendingHandler({ current: client }, baseConfig);
    expect(await message({ to: "user", content: "sensitive content" })).toEqual({ cancel: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retains configured high-risk approval after a persisted throttle stamp", async () => {
    stampThrottle(cacheDir, Date.now() + 3_600_000, "feature_pro_only");
    const fetchMock = jest.fn().mockResolvedValue(
      Response.json({ allowed: true, policies_evaluated: 1 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const config = { ...baseConfig, highRiskTools: ["payments_refund"] };
    const tool = createBeforeToolCallHandler({ current: new AxonFlowClient(config) }, config);

    expect(await tool({ toolName: "payments_refund", params: { amount: 100 } }))
      .toMatchObject({ requireApproval: { timeoutBehavior: "deny" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  for (const onError of ["allow", "block"] as const) {
    for (const status of [403, 429] as const) {
      it(`blocks a current ${status} limit for tools and messages with onError=${onError}`, async () => {
        const config = { ...baseConfig, onError };
        const fetchMock = jest.fn().mockImplementation(async () =>
          new Response(JSON.stringify(legacyLimit), { status }),
        );
        globalThis.fetch = fetchMock as typeof fetch;
        const client = new AxonFlowClient(config);

        const tool = createBeforeToolCallHandler({ current: client }, config);
        expect(await tool({ toolName: "web_fetch", params: {} })).toMatchObject({ block: true });
        const message = createMessageSendingHandler({ current: client }, config);
        expect(await message({ to: "user", content: "sensitive content" })).toEqual({ cancel: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    }
  }

  it("keeps an ordinary unstructured 429 transient for tool calls", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "temporary capacity limit" }), { status: 429 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const tool = createBeforeToolCallHandler({ current: new AxonFlowClient(baseConfig) }, baseConfig);

    expect(await tool({ toolName: "web_fetch", params: {} })).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
