/**
 * X-Axonflow-Client header injection — ADR-050 §4.
 *
 * Asserts every governed HTTP path forwards `X-Axonflow-Client: openclaw/<VERSION>`
 * so the agent can derive request scope (plugin) and validate against the
 * token's aud.scope via HasScope().
 *
 * The header value is computed at AxonFlowClient construction from the bundled
 * VERSION constant; the consumer cannot spoof its own client identity through
 * config (intentional — that's the agent's defense-in-depth posture).
 */

import { AxonFlowClient } from "../src/axonflow-client.js";
import { VERSION } from "../src/version.js";

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const EXPECTED_CLIENT = `openclaw/${VERSION}`;

function jsonResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : `HTTP ${status}`,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  };
}

function makeClient() {
  return new AxonFlowClient({
    endpoint: "http://localhost:8080",
    clientId: "test-client",
    clientSecret: "test-secret",
    mode: "self-hosted",
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("X-Axonflow-Client header injection", () => {
  it("includes X-Axonflow-Client on mcpCheckInput", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { allowed: true }));
    await makeClient().mcpCheckInput("openclaw.web_fetch", "{}");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/mcp/check-input",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Axonflow-Client": EXPECTED_CLIENT,
        }),
      }),
    );
  });

  it("includes X-Axonflow-Client on mcpCheckOutput", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { allowed: true }));
    await makeClient().mcpCheckOutput("openclaw.send_message", "hi");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/mcp/check-output"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Axonflow-Client": EXPECTED_CLIENT,
        }),
      }),
    );
  });

  it("includes X-Axonflow-Client on auditToolCall", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    await makeClient().auditToolCall("test_tool", { x: 1 });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/audit/tool-call"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Axonflow-Client": EXPECTED_CLIENT,
        }),
      }),
    );
  });

  it("includes X-Axonflow-Client on auditLLMCall", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    await makeClient().auditLLMCall(
      "anthropic",
      "claude-haiku-4-5",
      "q",
      "r",
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      0,
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/audit/tool-call"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Axonflow-Client": EXPECTED_CLIENT,
        }),
      }),
    );
  });

  it("client header carries the correct format: <client-id>/<version>", () => {
    // Sanity: agent's deriveScopeFromClientHeader splits on the slash and maps
    // the prefix to a scope. If we ever ship a value with extra slashes or a
    // different shape this test fails loudly so we don't regress agent-side
    // parsing in production.
    expect(EXPECTED_CLIENT).toMatch(/^openclaw\/[0-9]+\.[0-9]+\.[0-9]+/);
    expect(EXPECTED_CLIENT.split("/")).toHaveLength(2);
  });
});
