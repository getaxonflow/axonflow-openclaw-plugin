import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AxonFlowClient } from "../src/axonflow-client.js";
import { createBeforeToolCallHandler } from "../src/governance.js";
import { createMessageSendingHandler } from "../src/message-guard.js";
import type { AxonFlowPluginConfig } from "../src/config.js";

const config: AxonFlowPluginConfig = {
  endpoint: "https://try.getaxonflow.com",
  clientId: "linked-test",
  clientSecret: "test-secret",
  mode: "community-saas",
  onError: "allow",
};

describe("Hosted refusal wire responses", () => {
  const originalFetch = globalThis.fetch;
  const priorCacheDir = process.env["AXONFLOW_CACHE_DIR"];
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axonflow-hosted-wire-"));
    process.env["AXONFLOW_CACHE_DIR"] = cacheDir;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(cacheDir, { recursive: true, force: true });
    if (priorCacheDir === undefined) delete process.env["AXONFLOW_CACHE_DIR"];
    else process.env["AXONFLOW_CACHE_DIR"] = priorCacheDir;
  });

  const response = (status: number, body: string, tierLimit?: string) =>
    new Response(body, {
      status,
      headers: tierLimit ? { "X-Axonflow-Tier-Limit": tierLimit } : {},
    });

  for (const hook of ["tool", "message"] as const) {
    for (const [name, body, tierLimit] of [
      ["exact monthly body", '{"error":"hosted_monthly_limit_reached"}', undefined],
      ["truncated monthly body with Agent header", '{"error":', "monthly_governed_events"],
    ] as const) {
      it(`${hook} denies ${name} even with onError=allow`, async () => {
        const fetchMock = jest.fn().mockResolvedValue(response(429, body, tierLimit));
        globalThis.fetch = fetchMock as typeof fetch;
        const client = new AxonFlowClient(config);
        if (hook === "tool") {
          const check = createBeforeToolCallHandler({ current: client }, config);
          expect(await check({ toolName: "web_fetch", params: { url: "https://example.com" } }))
            .toMatchObject({ block: true });
        } else {
          const check = createMessageSendingHandler({ current: client }, config);
          expect(await check({ to: "user", content: "hello" })).toEqual({ cancel: true });
        }
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(path.join(cacheDir, "throttle-until"))).toBe(false);
      });
    }

    it(`${hook} denies a plain-text 402 even with onError=allow`, async () => {
      const fetchMock = jest.fn()
        .mockResolvedValueOnce(response(402, "Payment Required"))
        .mockResolvedValueOnce(response(200, '{"checkout_url":"https://checkout.stripe.com/test"}'));
      globalThis.fetch = fetchMock as typeof fetch;
      const client = new AxonFlowClient(config);
      if (hook === "tool") {
        const check = createBeforeToolCallHandler({ current: client }, config);
        expect(await check({ toolName: "web_fetch", params: {} })).toMatchObject({ block: true });
      } else {
        const check = createMessageSendingHandler({ current: client }, config);
        expect(await check({ to: "user", content: "hello" })).toEqual({ cancel: true });
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  }
});
