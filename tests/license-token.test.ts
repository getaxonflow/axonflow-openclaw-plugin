/**
 * X-License-Token plumbing — W4 paid Pro v1 tier.
 *
 * Asserts every governed HTTP path forwards `X-License-Token` when the
 * plugin is configured with a license token, and omits the header when
 * unconfigured. Also asserts the env-var precedence in resolveConfig.
 *
 * Runtime correctness for this feature lives in
 * `runtime-e2e/v1_paid_tier/test.sh` — these unit tests are the additive
 * regression net per FEATURE_RUNTIME_COVERAGE.md rule #1.
 */

import { AxonFlowClient } from "../src/axonflow-client.js";
import { resolveConfig } from "../src/config.js";

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function jsonResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : `HTTP ${status}`,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  };
}

function makeProClient() {
  return new AxonFlowClient({
    endpoint: "http://localhost:8080",
    clientId: "test-client",
    clientSecret: "test-secret",
    licenseToken: "AXON-test-pro-token-abcdef",
    mode: "self-hosted",
  });
}

function makeFreeClient() {
  return new AxonFlowClient({
    endpoint: "http://localhost:8080",
    clientId: "test-client",
    clientSecret: "test-secret",
    mode: "self-hosted",
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  // Don't let real env contaminate config-resolution tests.
  delete process.env.AXONFLOW_LICENSE_TOKEN;
});

describe("X-License-Token forwarding", () => {
  it("includes X-License-Token on mcpCheckInput when configured", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { allowed: true }));
    await makeProClient().mcpCheckInput("openclaw.web_fetch", "{}");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/mcp/check-input",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-License-Token": "AXON-test-pro-token-abcdef",
        }),
      }),
    );
  });

  it("includes X-License-Token on mcpCheckOutput when configured", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { allowed: true }));
    await makeProClient().mcpCheckOutput("openclaw.send_message", "hi");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/mcp/check-output"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-License-Token": "AXON-test-pro-token-abcdef",
        }),
      }),
    );
  });

  it("includes X-License-Token on auditToolCall when configured", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    await makeProClient().auditToolCall("test_tool", { x: 1 });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/audit/tool-call"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-License-Token": "AXON-test-pro-token-abcdef",
        }),
      }),
    );
  });

  it("includes X-License-Token on auditLLMCall when configured", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    await makeProClient().auditLLMCall(
      "anthropic",
      "claude-haiku-4-5",
      "q",
      "r",
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      150,
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/audit/tool-call"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-License-Token": "AXON-test-pro-token-abcdef",
        }),
      }),
    );
  });

  it("includes X-License-Token on searchAuditEvents when configured", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { entries: [], total: 0 }));
    await makeProClient().searchAuditEvents();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/audit/search"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-License-Token": "AXON-test-pro-token-abcdef",
        }),
      }),
    );
  });

  it("includes X-License-Token on createOverride / revokeOverride / listOverrides", async () => {
    const client = makeProClient();
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { id: "ov_1" }));
    await client.createOverride({
      policyId: "p",
      policyType: "static",
      overrideReason: "test",
    });

    mockFetch.mockResolvedValueOnce(jsonResponse(204, {}));
    await client.revokeOverride("ov_1");

    mockFetch.mockResolvedValueOnce(jsonResponse(200, { overrides: [], count: 0 }));
    await client.listOverrides();

    for (const call of mockFetch.mock.calls) {
      expect(call[1]?.headers).toEqual(
        expect.objectContaining({ "X-License-Token": "AXON-test-pro-token-abcdef" }),
      );
    }
  });

  it("includes X-License-Token on explainDecision when configured", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { decision_id: "d" }));
    await makeProClient().explainDecision("d-1");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/decisions/d-1/explain"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-License-Token": "AXON-test-pro-token-abcdef",
        }),
      }),
    );
  });

  it("does NOT include X-License-Token on free-tier client", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { allowed: true }));
    await makeFreeClient().mcpCheckInput("openclaw.web_fetch", "{}");
    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-License-Token"]).toBeUndefined();
  });

  it("treats whitespace-only licenseToken as unset", async () => {
    const client = new AxonFlowClient({
      endpoint: "http://localhost:8080",
      clientId: "c",
      clientSecret: "s",
      licenseToken: "   ",
      mode: "self-hosted",
    });
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { allowed: true }));
    await client.mcpCheckInput("t", "{}");
    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-License-Token"]).toBeUndefined();
  });

  it("trims whitespace around a valid licenseToken before forwarding", async () => {
    const client = new AxonFlowClient({
      endpoint: "http://localhost:8080",
      clientId: "c",
      clientSecret: "s",
      licenseToken: "  AXON-padded-token  ",
      mode: "self-hosted",
    });
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { allowed: true }));
    await client.mcpCheckInput("t", "{}");
    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-License-Token"]).toBe("AXON-padded-token");
  });
});

describe("resolveConfig license-token resolution", () => {
  it("reads from process.env.AXONFLOW_LICENSE_TOKEN when set", () => {
    process.env.AXONFLOW_LICENSE_TOKEN = "AXON-from-env";
    const cfg = resolveConfig({ endpoint: "http://localhost:8080" });
    expect(cfg.licenseToken).toBe("AXON-from-env");
  });

  it("falls back to pluginConfig.licenseToken when env unset", () => {
    delete process.env.AXONFLOW_LICENSE_TOKEN;
    const cfg = resolveConfig({
      endpoint: "http://localhost:8080",
      licenseToken: "AXON-from-config",
    });
    expect(cfg.licenseToken).toBe("AXON-from-config");
  });

  it("env wins over pluginConfig (consistent with other AxonFlow surfaces)", () => {
    process.env.AXONFLOW_LICENSE_TOKEN = "AXON-from-env-wins";
    const cfg = resolveConfig({
      endpoint: "http://localhost:8080",
      licenseToken: "AXON-config-loses",
    });
    expect(cfg.licenseToken).toBe("AXON-from-env-wins");
  });

  it("returns undefined when neither source is set", () => {
    delete process.env.AXONFLOW_LICENSE_TOKEN;
    const cfg = resolveConfig({ endpoint: "http://localhost:8080" });
    expect(cfg.licenseToken).toBeUndefined();
  });

  it("treats empty / whitespace env value as unset", () => {
    process.env.AXONFLOW_LICENSE_TOKEN = "   ";
    const cfg = resolveConfig({
      endpoint: "http://localhost:8080",
      licenseToken: "AXON-config-fallback",
    });
    // Whitespace env is treated as unset → config value wins.
    expect(cfg.licenseToken).toBe("AXON-config-fallback");
  });

  it("treats non-string config value as unset", () => {
    delete process.env.AXONFLOW_LICENSE_TOKEN;
    const cfg = resolveConfig({
      endpoint: "http://localhost:8080",
      licenseToken: 12345 as unknown as string,
    });
    expect(cfg.licenseToken).toBeUndefined();
  });
});
