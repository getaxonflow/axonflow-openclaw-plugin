/**
 * Regression test for the hook closure bug.
 *
 * Hook factories must capture a *holder* (`{ current: AxonFlowClient }`),
 * not the AxonFlowClient by value. If they capture by value, the async
 * Community-SaaS bootstrap reassignment is dead code: every registered
 * hook keeps using the original empty-credential client and every
 * governed tool call ships out as `Authorization: Basic :`.
 *
 * This test fails if a future refactor changes the factory signature
 * back to `(client: AxonFlowClient, ...)` — i.e. the bug recurs.
 */

import { createBeforeToolCallHandler } from "../src/governance.js";
import type { AxonFlowClient } from "../src/axonflow-client.js";
import type { ClientRef } from "../src/client-ref.js";
import type { AxonFlowPluginConfig } from "../src/config.js";

function makeMockClient(label: string): AxonFlowClient {
  return {
    mcpCheckInput: jest.fn().mockResolvedValue({
      allowed: true,
      policies_evaluated: 0,
      _label: label,
    }),
    auditToolCall: jest.fn().mockResolvedValue(undefined),
    healthCheck: jest.fn().mockResolvedValue(true),
  } as unknown as AxonFlowClient;
}

const baseConfig: AxonFlowPluginConfig = {
  endpoint: "http://localhost:8080",
  clientId: "test",
  clientSecret: "secret",
  mode: "community-saas",
  defaultOperation: "execute",
};

describe("ClientRef holder propagates bootstrap reassignment", () => {
  it("hook reads through clientRef.current — reassignment after handler creation IS visible", async () => {
    const original = makeMockClient("pre-bootstrap");
    const enriched = makeMockClient("post-bootstrap");

    const clientRef: ClientRef = { current: original };
    const handler = createBeforeToolCallHandler(clientRef, baseConfig);

    // Simulate the bootstrap completing AFTER the hook was registered.
    clientRef.current = enriched;

    await handler({ toolName: "any", params: { x: 1 } });

    // The handler must have called the ENRICHED client's mcpCheckInput,
    // not the original. If this assertion fails, the holder pattern broke
    // and the bootstrap reassignment is silently doing nothing.
    expect((enriched.mcpCheckInput as jest.Mock).mock.calls.length).toBe(1);
    expect((original.mcpCheckInput as jest.Mock).mock.calls.length).toBe(0);
  });

  it("multiple sequential reassignments all reach the registered hook", async () => {
    const a = makeMockClient("a");
    const b = makeMockClient("b");
    const c = makeMockClient("c");

    const clientRef: ClientRef = { current: a };
    const handler = createBeforeToolCallHandler(clientRef, baseConfig);

    await handler({ toolName: "t", params: {} });
    clientRef.current = b;
    await handler({ toolName: "t", params: {} });
    clientRef.current = c;
    await handler({ toolName: "t", params: {} });

    expect((a.mcpCheckInput as jest.Mock).mock.calls.length).toBe(1);
    expect((b.mcpCheckInput as jest.Mock).mock.calls.length).toBe(1);
    expect((c.mcpCheckInput as jest.Mock).mock.calls.length).toBe(1);
  });
});
