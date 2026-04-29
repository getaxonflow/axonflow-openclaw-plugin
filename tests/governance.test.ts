import {
  createBeforeToolCallHandler,
  deriveConnectorType,
  formatRicherContext,
} from "../src/governance.js";
import type { MCPCheckInputResponse } from "../src/axonflow-client.js";
import { createAfterToolCallHandler } from "../src/audit.js";
import { resolveConfig, shouldGovernTool } from "../src/config.js";
import { AxonFlowClient } from "../src/axonflow-client.js";
import type { AxonFlowPluginConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function mockClient(overrides: {
  checkInputAllowed?: boolean;
  checkInputBlockReason?: string;
  checkInputPoliciesEvaluated?: number;
  checkInputRicher?: Partial<MCPCheckInputResponse>;
}) {
  return {
    mcpCheckInput: jest.fn().mockResolvedValue({
      allowed: overrides.checkInputAllowed ?? true,
      block_reason: overrides.checkInputBlockReason,
      policies_evaluated: overrides.checkInputPoliciesEvaluated ?? 76,
      ...(overrides.checkInputRicher ?? {}),
    }),
    auditToolCall: jest.fn().mockResolvedValue(undefined),
    healthCheck: jest.fn().mockResolvedValue(true),
  } as unknown as AxonFlowClient;
}

function baseConfig(overrides?: Partial<AxonFlowPluginConfig>): AxonFlowPluginConfig {
  return {
    endpoint: "http://localhost:8080",
    clientId: "test-client",
    clientSecret: "test-secret",
    mode: "self-hosted",
    highRiskTools: [],
    governedTools: [],
    excludedTools: [],
    defaultOperation: "execute",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Config Tests
// ---------------------------------------------------------------------------

describe("resolveConfig", () => {
  it("validates required fields", () => {
    // ADR-048: undefined and {} are treated as "no explicit user config" and
    // resolve to Community-SaaS mode (no throw). Only mis-configurations
    // throw — see the clientSecret-without-clientId case below.
    expect(resolveConfig(undefined)).toMatchObject({
      endpoint: "https://try.getaxonflow.com",
      clientId: "",
      clientSecret: "",
      mode: "community-saas",
    });
    expect(resolveConfig({})).toMatchObject({
      endpoint: "https://try.getaxonflow.com",
      mode: "community-saas",
    });
    // Endpoint set → self-hosted; clientId defaults to "community" so the
    // resulting client doesn't ship a half-credentialled request.
    expect(resolveConfig({ endpoint: "http://x" })).toMatchObject({
      clientId: "community",
      clientSecret: "",
      mode: "self-hosted",
    });
    // clientId set with no clientSecret: community-credentialled self-hosted.
    expect(resolveConfig({ endpoint: "http://x", clientId: "my-tenant" })).toMatchObject({
      clientId: "my-tenant",
      clientSecret: "",
      mode: "self-hosted",
    });
    // clientSecret without clientId is the one true error condition: licensed
    // setups must specify the tenant identity, otherwise the deployment
    // ships a malformed Authorization header.
    expect(() =>
      resolveConfig({ endpoint: "http://x", clientSecret: "my-license" }),
    ).toThrow("'clientId' is required when 'clientSecret' is set");
  });

  it("returns valid config with defaults", () => {
    const config = resolveConfig({
      endpoint: "http://localhost:8080",
      clientId: "my-id",
      clientSecret: "my-secret",
    });
    expect(config.endpoint).toBe("http://localhost:8080");
    expect(config.clientId).toBe("my-id");
    expect(config.defaultOperation).toBe("execute");
    expect(config.requestTimeoutMs).toBe(8000);
    expect(config.highRiskTools).toEqual([]);
    expect(config.governedTools).toEqual([]);
    expect(config.excludedTools).toEqual([]);
  });

  it("parses optional arrays", () => {
    const config = resolveConfig({
      endpoint: "http://x",
      clientId: "id",
      clientSecret: "secret",
      highRiskTools: ["web_fetch", "message"],
      excludedTools: ["safe_tool"],
    });
    expect(config.highRiskTools).toEqual(["web_fetch", "message"]);
    expect(config.excludedTools).toEqual(["safe_tool"]);
  });

  it("parses requestTimeoutMs when provided", () => {
    const config = resolveConfig({
      endpoint: "http://x",
      requestTimeoutMs: 15000,
    });
    expect(config.requestTimeoutMs).toBe(15000);
  });

  it("parses userEmail for Plugin Batch 1 per-user scoping", () => {
    const config = resolveConfig({
      endpoint: "http://x",
      userEmail: "alice@example.com",
    });
    expect(config.userEmail).toBe("alice@example.com");
  });

  it("trims surrounding whitespace from userEmail", () => {
    const config = resolveConfig({
      endpoint: "http://x",
      userEmail: "  bob@example.com  ",
    });
    expect(config.userEmail).toBe("bob@example.com");
  });

  it("drops empty / whitespace-only userEmail", () => {
    expect(resolveConfig({ endpoint: "http://x", userEmail: "" }).userEmail).toBeUndefined();
    expect(resolveConfig({ endpoint: "http://x", userEmail: "   " }).userEmail).toBeUndefined();
  });

  it("leaves userEmail undefined when not set", () => {
    const config = resolveConfig({ endpoint: "http://x" });
    expect(config.userEmail).toBeUndefined();
  });

  it("ignores non-string userEmail values", () => {
    const config = resolveConfig({
      endpoint: "http://x",
      userEmail: 42 as unknown as string,
    });
    expect(config.userEmail).toBeUndefined();
  });
});

describe("shouldGovernTool", () => {
  it("governs all tools by default", () => {
    expect(shouldGovernTool("any_tool", baseConfig())).toBe(true);
  });

  it("excludes tools in excludedTools", () => {
    expect(
      shouldGovernTool("safe", baseConfig({ excludedTools: ["safe"] })),
    ).toBe(false);
  });

  it("only governs tools in governedTools when specified", () => {
    const config = baseConfig({ governedTools: ["web_fetch"] });
    expect(shouldGovernTool("web_fetch", config)).toBe(true);
    expect(shouldGovernTool("other", config)).toBe(false);
  });

  it("excludedTools takes precedence over governedTools", () => {
    const config = baseConfig({
      governedTools: ["web_fetch"],
      excludedTools: ["web_fetch"],
    });
    expect(shouldGovernTool("web_fetch", config)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connector Type Derivation
// ---------------------------------------------------------------------------

describe("deriveConnectorType", () => {
  it("prefixes with openclaw.", () => {
    expect(deriveConnectorType("web_fetch")).toBe("openclaw.web_fetch");
    expect(deriveConnectorType("message")).toBe("openclaw.message");
    expect(deriveConnectorType("mcp.postgres")).toBe("openclaw.mcp.postgres");
  });
});

// ---------------------------------------------------------------------------
// before_tool_call (Input Governance)
// ---------------------------------------------------------------------------

describe("createBeforeToolCallHandler", () => {
  it("allows clean tool call", async () => {
    const client = mockClient({ checkInputAllowed: true });
    const handler = createBeforeToolCallHandler(client, baseConfig());

    const result = await handler({
      toolName: "web_fetch",
      params: { url: "https://example.com" },
    });

    expect(result).toBeUndefined();
    expect(client.mcpCheckInput).toHaveBeenCalledWith(
      "openclaw.web_fetch",
      JSON.stringify({ url: "https://example.com" }),
      "execute",
    );
  });

  it("blocks when policy denies", async () => {
    const client = mockClient({
      checkInputAllowed: false,
      checkInputBlockReason: "PII detected in tool arguments",
    });
    const handler = createBeforeToolCallHandler(client, baseConfig());

    const result = await handler({
      toolName: "message",
      params: { text: "SSN: 123-45-6789" },
    });

    expect(result).toEqual({
      block: true,
      blockReason: "PII detected in tool arguments",
    });
  });

  it("uses fallback block reason when none provided", async () => {
    const client = mockClient({ checkInputAllowed: false });
    const handler = createBeforeToolCallHandler(client, baseConfig());

    const result = await handler({ toolName: "tool", params: {} });

    expect(result?.blockReason).toBe("Blocked by AxonFlow policy");
  });

  it("requires approval for high-risk tools when allowed", async () => {
    const client = mockClient({ checkInputAllowed: true, checkInputPoliciesEvaluated: 76 });
    const config = baseConfig({ highRiskTools: ["web_fetch"] });
    const handler = createBeforeToolCallHandler(client, config);

    const result = await handler({
      toolName: "web_fetch",
      params: { url: "https://example.com" },
    });

    expect(result?.requireApproval).toBeDefined();
    expect(result?.requireApproval?.title).toContain("web_fetch");
    expect(result?.requireApproval?.severity).toBe("warning");
    expect(result?.requireApproval?.timeoutBehavior).toBe("deny");
  });

  // -------------------------------------------------------------------------
  // Plugin Batch 1: richer context reaches the OpenClaw governance UX
  // (reviewer-caught: previous fix wired only the client parser; these tests
  // lock in that governance.ts actually surfaces the fields through to the
  // BeforeToolCallResult that OpenClaw consumes.)
  // -------------------------------------------------------------------------

  it("block reason carries decision_id + risk + policy name when platform returns them", async () => {
    const client = mockClient({
      checkInputAllowed: false,
      checkInputBlockReason: "SQL injection detected",
      checkInputRicher: {
        decision_id: "dec_wf1_step2",
        risk_level: "high",
        policy_matches: [
          {
            policy_id: "pol-sqli",
            policy_name: "SQL Injection Detector",
            allow_override: true,
          },
        ],
        override_available: true,
        override_existing_id: "ov-abc",
      },
    });
    const handler = createBeforeToolCallHandler(client, baseConfig());

    const result = await handler({
      toolName: "web_fetch",
      params: { url: "https://attacker.example.com" },
    });

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("SQL injection detected");
    expect(result?.blockReason).toContain("decision: dec_wf1_step2");
    expect(result?.blockReason).toContain("risk: high");
    expect(result?.blockReason).toContain("policy: SQL Injection Detector");
    expect(result?.blockReason).toContain("active override: ov-abc");
  });

  it("block reason falls back cleanly when platform omits richer fields (older platform)", async () => {
    const client = mockClient({
      checkInputAllowed: false,
      checkInputBlockReason: "blocked",
    });
    const handler = createBeforeToolCallHandler(client, baseConfig());

    const result = await handler({ toolName: "tool", params: {} });

    expect(result?.blockReason).toBe("blocked");
    // Must NOT include any bracketed suffix when there's nothing to say
    expect(result?.blockReason).not.toContain("[");
  });

  it("approval description carries richer context for high-risk tool", async () => {
    const client = mockClient({
      checkInputAllowed: true,
      checkInputPoliciesEvaluated: 12,
      checkInputRicher: {
        decision_id: "dec_allow_but_high_risk",
        risk_level: "high",
        policy_matches: [
          {
            policy_id: "pol-net",
            policy_name: "Network Egress Control",
            allow_override: true,
          },
        ],
        override_available: true,
      },
    });
    const config = baseConfig({ highRiskTools: ["web_fetch"] });
    const handler = createBeforeToolCallHandler(client, config);

    const result = await handler({
      toolName: "web_fetch",
      params: { url: "https://api.example.com" },
    });

    expect(result?.requireApproval).toBeDefined();
    expect(result?.requireApproval?.description).toContain(
      "decision: dec_allow_but_high_risk",
    );
    expect(result?.requireApproval?.description).toContain(
      "policy: Network Egress Control",
    );
    expect(result?.requireApproval?.description).toContain("risk: high");
    // high-risk maps to critical severity
    expect(result?.requireApproval?.severity).toBe("critical");
  });

  it("approval severity maps from risk_level (critical→critical, low→info)", async () => {
    const highRiskConfig = baseConfig({ highRiskTools: ["t"] });

    const clientCritical = mockClient({
      checkInputAllowed: true,
      checkInputRicher: { risk_level: "critical" },
    });
    const rCritical = await createBeforeToolCallHandler(clientCritical, highRiskConfig)({
      toolName: "t",
      params: {},
    });
    expect(rCritical?.requireApproval?.severity).toBe("critical");

    const clientLow = mockClient({
      checkInputAllowed: true,
      checkInputRicher: { risk_level: "low" },
    });
    const rLow = await createBeforeToolCallHandler(clientLow, highRiskConfig)({
      toolName: "t",
      params: {},
    });
    expect(rLow?.requireApproval?.severity).toBe("info");

    const clientMedium = mockClient({
      checkInputAllowed: true,
      checkInputRicher: { risk_level: "medium" },
    });
    const rMedium = await createBeforeToolCallHandler(clientMedium, highRiskConfig)({
      toolName: "t",
      params: {},
    });
    expect(rMedium?.requireApproval?.severity).toBe("warning");
  });

  it("formatRicherContext emits empty string when nothing to say", () => {
    expect(
      formatRicherContext({
        allowed: true,
        policies_evaluated: 0,
      }),
    ).toBe("");
  });

  it("formatRicherContext omits override line when override_available=false", () => {
    const s = formatRicherContext({
      allowed: false,
      policies_evaluated: 1,
      decision_id: "dec-1",
      risk_level: "critical",
      override_available: false,
    });
    expect(s).toContain("decision: dec-1");
    expect(s).toContain("risk: critical");
    expect(s).not.toContain("override");
  });

  it("formatRicherContext points to explain_decision tool when override available but not yet created", () => {
    const s = formatRicherContext({
      allowed: false,
      policies_evaluated: 1,
      decision_id: "dec-2",
      override_available: true,
      // no override_existing_id
    });
    expect(s).toContain("override available via explain_decision MCP tool");
    expect(s).not.toContain("active override:");
  });

  it("blocks high-risk tools when policy denies (block takes precedence)", async () => {
    const client = mockClient({
      checkInputAllowed: false,
      checkInputBlockReason: "SQLi detected",
    });
    const config = baseConfig({ highRiskTools: ["web_fetch"] });
    const handler = createBeforeToolCallHandler(client, config);

    const result = await handler({
      toolName: "web_fetch",
      params: { url: "'; DROP TABLE users;--" },
    });

    expect(result?.block).toBe(true);
    expect(result?.requireApproval).toBeUndefined();
  });

  it("skips excluded tools", async () => {
    const client = mockClient({});
    const config = baseConfig({ excludedTools: ["safe_tool"] });
    const handler = createBeforeToolCallHandler(client, config);

    const result = await handler({ toolName: "safe_tool", params: {} });

    expect(result).toBeUndefined();
    expect(client.mcpCheckInput).not.toHaveBeenCalled();
  });

  it("uses custom operation from config", async () => {
    const client = mockClient({ checkInputAllowed: true });
    const config = baseConfig({ defaultOperation: "query" });
    const handler = createBeforeToolCallHandler(client, config);

    await handler({ toolName: "search", params: { q: "test" } });

    expect(client.mcpCheckInput).toHaveBeenCalledWith(
      "openclaw.search",
      expect.any(String),
      "query",
    );
  });

  it("ALWAYS fails open on network error even when onError=block (#1545)", async () => {
    // Issue #1545 Direction 3: network errors always fail-open regardless
    // of config.onError. Only auth errors respect the config.
    const client = mockClient({});
    (client.mcpCheckInput as jest.Mock).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const handler = createBeforeToolCallHandler(client, baseConfig());

    const result = await handler({ toolName: "web_fetch", params: {} });

    // Network errors never block — even with the default onError=block.
    expect(result).toBeUndefined();
  });

  it("allows on network error when onError=allow", async () => {
    const client = mockClient({});
    (client.mcpCheckInput as jest.Mock).mockRejectedValueOnce(new Error("timeout"));
    const config = baseConfig({ onError: "allow" as const });
    const handler = createBeforeToolCallHandler(client, config);

    const result = await handler({ toolName: "web_fetch", params: {} });

    expect(result).toBeUndefined();
  });

  it("blocks on AUTH error when onError=block (default) — operator fixable (#1545)", async () => {
    const client = mockClient({});
    (client.mcpCheckInput as jest.Mock).mockRejectedValueOnce(
      new Error("HTTP 401 Unauthorized: invalid credentials"),
    );
    const handler = createBeforeToolCallHandler(client, baseConfig());

    const result = await handler({ toolName: "web_fetch", params: {} });

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("auth");
  });

  it("allows on AUTH error when onError=allow (operator explicit opt-in)", async () => {
    const client = mockClient({});
    (client.mcpCheckInput as jest.Mock).mockRejectedValueOnce(
      new Error("HTTP 403 Forbidden"),
    );
    const config = baseConfig({ onError: "allow" as const });
    const handler = createBeforeToolCallHandler(client, config);

    const result = await handler({ toolName: "web_fetch", params: {} });

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isAxonFlowAuthError classification (#1545 Direction 3)
// ---------------------------------------------------------------------------
import { isAxonFlowAuthError } from "../src/governance.js";

describe("isAxonFlowAuthError", () => {
  it("classifies HTTP 401 by status", () => {
    expect(isAxonFlowAuthError({ status: 401 })).toBe(true);
  });
  it("classifies HTTP 403 by statusCode", () => {
    expect(isAxonFlowAuthError({ statusCode: 403 })).toBe(true);
  });
  it("classifies 401 in message", () => {
    expect(isAxonFlowAuthError(new Error("HTTP 401 Unauthorized"))).toBe(true);
  });
  it("classifies unauthorized in message", () => {
    expect(isAxonFlowAuthError(new Error("unauthorized"))).toBe(true);
  });
  it("classifies forbidden in message", () => {
    expect(isAxonFlowAuthError(new Error("forbidden"))).toBe(true);
  });
  it("classifies credentials in message", () => {
    expect(isAxonFlowAuthError(new Error("invalid credentials"))).toBe(true);
  });
  it("classifies invalid token", () => {
    expect(isAxonFlowAuthError(new Error("invalid token"))).toBe(true);
  });
  it("does NOT classify ECONNREFUSED", () => {
    expect(isAxonFlowAuthError(new Error("ECONNREFUSED"))).toBe(false);
  });
  it("does NOT classify timeout", () => {
    expect(isAxonFlowAuthError(new Error("request timeout"))).toBe(false);
  });
  it("does NOT classify DNS failure", () => {
    expect(isAxonFlowAuthError(new Error("getaddrinfo ENOTFOUND"))).toBe(false);
  });
  it("does NOT classify 500 errors", () => {
    expect(isAxonFlowAuthError(new Error("HTTP 500 Internal Server Error"))).toBe(false);
  });
  it("does NOT classify null/undefined", () => {
    expect(isAxonFlowAuthError(null)).toBe(false);
    expect(isAxonFlowAuthError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// after_tool_call (Audit)
// ---------------------------------------------------------------------------

describe("createAfterToolCallHandler", () => {
  it("logs successful tool call", async () => {
    const client = mockClient({});
    const handler = createAfterToolCallHandler(client, baseConfig());

    await handler({
      toolName: "web_fetch",
      params: { url: "https://example.com" },
      result: "page content",
      durationMs: 150,
    });

    expect(client.auditToolCall).toHaveBeenCalledWith(
      "web_fetch",
      { url: "https://example.com" },
      "page content",
      undefined,
      150,
    );
  });

  it("logs failed tool call with error", async () => {
    const client = mockClient({});
    const handler = createAfterToolCallHandler(client, baseConfig());

    await handler({
      toolName: "web_fetch",
      params: { url: "https://bad.com" },
      error: "Connection refused",
      durationMs: 50,
    });

    expect(client.auditToolCall).toHaveBeenCalledWith(
      "web_fetch",
      { url: "https://bad.com" },
      undefined,
      "Connection refused",
      50,
    );
  });

  it("skips excluded tools", async () => {
    const client = mockClient({});
    const config = baseConfig({ excludedTools: ["safe"] });
    const handler = createAfterToolCallHandler(client, config);

    await handler({ toolName: "safe", params: {} });

    expect(client.auditToolCall).not.toHaveBeenCalled();
  });
});
