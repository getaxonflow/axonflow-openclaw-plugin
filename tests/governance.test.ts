import { createBeforeToolCallHandler, deriveConnectorType } from "../src/governance.js";
import { createOutputGuardHandler, extractTextContent } from "../src/output-guard.js";
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
  checkOutputAllowed?: boolean;
  checkOutputBlockReason?: string;
  checkOutputRedactedData?: unknown;
}) {
  return {
    mcpCheckInput: jest.fn().mockResolvedValue({
      allowed: overrides.checkInputAllowed ?? true,
      block_reason: overrides.checkInputBlockReason,
      policies_evaluated: overrides.checkInputPoliciesEvaluated ?? 76,
    }),
    mcpCheckOutput: jest.fn().mockResolvedValue({
      allowed: overrides.checkOutputAllowed ?? true,
      block_reason: overrides.checkOutputBlockReason,
      redacted_data: overrides.checkOutputRedactedData,
      policies_evaluated: 76,
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
    expect(() => resolveConfig(undefined)).toThrow("requires configuration");
    expect(() => resolveConfig({})).toThrow("'endpoint' is required");
    expect(() => resolveConfig({ endpoint: "http://x" })).toThrow("'clientId' is required");
    expect(() =>
      resolveConfig({ endpoint: "http://x", clientId: "id" }),
    ).toThrow("'clientSecret' is required");
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
});

// ---------------------------------------------------------------------------
// tool_result_persist (Output Governance)
// ---------------------------------------------------------------------------

describe("extractTextContent", () => {
  it("extracts string content", () => {
    expect(extractTextContent({ content: "hello world" })).toBe("hello world");
  });

  it("extracts from content array with text objects", () => {
    const msg = {
      content: [
        { type: "text", text: "Part 1" },
        { type: "text", text: "Part 2" },
      ],
    };
    expect(extractTextContent(msg)).toBe("Part 1 Part 2");
  });

  it("extracts from string array", () => {
    expect(extractTextContent({ content: ["a", "b"] })).toBe("a b");
  });

  it("handles null/undefined content", () => {
    expect(extractTextContent({})).toBe("");
    expect(extractTextContent({ content: null })).toBe("");
  });

  it("JSON-stringifies non-string non-array content", () => {
    expect(extractTextContent({ content: { key: "val" } })).toBe('{"key":"val"}');
  });
});

describe("createOutputGuardHandler", () => {
  it("allows clean output", async () => {
    const client = mockClient({ checkOutputAllowed: true });
    const handler = createOutputGuardHandler(client, baseConfig());

    const result = await handler({
      toolName: "search",
      message: { content: "Clean search results" },
    });

    expect(result).toBeUndefined();
  });

  it("redacts PII in output", async () => {
    const client = mockClient({
      checkOutputAllowed: true,
      checkOutputRedactedData: "Name: John, SSN: ***-**-6789",
    });
    const handler = createOutputGuardHandler(client, baseConfig());

    const result = await handler({
      toolName: "search",
      message: { content: "Name: John, SSN: 123-45-6789" },
    });

    expect(result).toBeDefined();
    expect(result?.message?.["content"]).toBe("Name: John, SSN: ***-**-6789");
  });

  it("blocks output when policy denies", async () => {
    const client = mockClient({
      checkOutputAllowed: false,
      checkOutputBlockReason: "Exfiltration detected",
    });
    const handler = createOutputGuardHandler(client, baseConfig());

    const result = await handler({
      toolName: "search",
      message: { content: "10000 rows of customer data" },
    });

    expect(result?.message?.["content"]).toContain("blocked");
    expect(result?.message?.["content"]).toContain("Exfiltration detected");
  });

  it("skips synthetic messages", async () => {
    const client = mockClient({});
    const handler = createOutputGuardHandler(client, baseConfig());

    const result = await handler({
      toolName: "search",
      message: { content: "synthetic" },
      isSynthetic: true,
    });

    expect(result).toBeUndefined();
    expect(client.mcpCheckOutput).not.toHaveBeenCalled();
  });

  it("skips empty content", async () => {
    const client = mockClient({});
    const handler = createOutputGuardHandler(client, baseConfig());

    const result = await handler({
      toolName: "search",
      message: {},
    });

    expect(result).toBeUndefined();
    expect(client.mcpCheckOutput).not.toHaveBeenCalled();
  });

  it("skips excluded tools", async () => {
    const client = mockClient({});
    const config = baseConfig({ excludedTools: ["safe"] });
    const handler = createOutputGuardHandler(client, config);

    const result = await handler({
      toolName: "safe",
      message: { content: "data" },
    });

    expect(result).toBeUndefined();
    expect(client.mcpCheckOutput).not.toHaveBeenCalled();
  });

  it("uses correct connector type in output check", async () => {
    const client = mockClient({ checkOutputAllowed: true });
    const handler = createOutputGuardHandler(client, baseConfig());

    await handler({
      toolName: "web_fetch",
      message: { content: "response data" },
    });

    expect(client.mcpCheckOutput).toHaveBeenCalledWith(
      "openclaw.web_fetch",
      "response data",
    );
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
