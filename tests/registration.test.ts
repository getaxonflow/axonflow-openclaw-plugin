import { registerAxonFlowGovernance } from "../src/index.js";

// Mock fetch for AxonFlowClient + bootstrap.
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe("registerAxonFlowGovernance", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Default: any fetch returns 503 so we never hit a real network.
    // Tests that care about a specific response set their own mock.
    mockFetch.mockResolvedValue(new Response("", { status: 503 }));
  });

  it("registers all five hooks", () => {
    const hooks: Array<{ event: string; handler: unknown; priority?: number }> = [];
    const api = {
      pluginConfig: {
        endpoint: "http://localhost:8080",
        clientId: "test",
        clientSecret: "secret",
      },
      logger: { info: jest.fn(), error: jest.fn() },
      on: jest.fn((event: string | string[], handler: unknown, opts?: { priority?: number }) => {
        const eventStr = Array.isArray(event) ? event.join(",") : event;
        hooks.push({ event: eventStr, handler, priority: opts?.priority });
      }),
    };

    registerAxonFlowGovernance(api);

    expect(api.on).toHaveBeenCalledTimes(5);
    expect(hooks[0]?.event).toBe("before_tool_call");
    expect(hooks[0]?.priority).toBe(10);
    expect(hooks[1]?.event).toBe("after_tool_call");
    expect(hooks[1]?.priority).toBe(90);
    expect(hooks[2]?.event).toBe("message_sending");
    expect(hooks[2]?.priority).toBe(10);
    expect(hooks[3]?.event).toBe("llm_input");
    expect(hooks[3]?.priority).toBe(90);
    expect(hooks[4]?.event).toBe("llm_output");
    expect(hooks[4]?.priority).toBe(90);
  });

  it("emits the mode-clarity canary on every init (self-hosted path)", () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const api = {
      pluginConfig: {
        endpoint: "http://localhost:8080",
        clientId: "test",
        clientSecret: "secret",
        highRiskTools: ["web_fetch", "message"],
      },
      logger,
      on: jest.fn(),
    };

    registerAxonFlowGovernance(api);

    // The mode-clarity canary that the Gate 4 mode-clarity test asserts against.
    expect(logger.info).toHaveBeenCalledWith(
      "[AxonFlow] Connected to AxonFlow at http://localhost:8080 (mode=self-hosted)",
    );
  });

  it("emits the mode-clarity canary in community-saas mode when no config is provided", () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const api = {
      pluginConfig: {}, // no explicit config → community-saas
      logger,
      on: jest.fn(),
    };

    registerAxonFlowGovernance(api);

    expect(logger.info).toHaveBeenCalledWith(
      "[AxonFlow] Connected to AxonFlow at https://try.getaxonflow.com (mode=community-saas)",
    );
  });

  it("treats undefined pluginConfig as community-saas mode (no throw)", () => {
    // Per ADR-048, undefined pluginConfig is the same as no explicit user
    // configuration: plugin defaults to Community SaaS. This is a behavior
    // change from pre-ADR-048 (used to throw "requires configuration").
    const logger = { info: jest.fn(), error: jest.fn() };
    const api = {
      pluginConfig: undefined,
      logger,
      on: jest.fn(),
    };

    expect(() => registerAxonFlowGovernance(api)).not.toThrow();
    expect(logger.info).toHaveBeenCalledWith(
      "[AxonFlow] Connected to AxonFlow at https://try.getaxonflow.com (mode=community-saas)",
    );
  });

  it("registers all 9 agent-callable tools when registerTool API is present (the override writes are retired)", () => {
    const registered: Array<{ name: string; description: string }> = [];
    const logger = { info: jest.fn(), error: jest.fn() };
    const api = {
      pluginConfig: {
        endpoint: "http://localhost:8080",
        clientId: "test",
        clientSecret: "secret",
      },
      logger,
      on: jest.fn(),
      registerTool: jest.fn(
        (tool: { name: string; description: string }) => {
          registered.push({ name: tool.name, description: tool.description });
        },
      ),
    };

    registerAxonFlowGovernance(api);

    expect(api.registerTool).toHaveBeenCalledTimes(9);
    expect(registered.map((t) => t.name).sort()).toEqual([
      "axonflow_audit_search",
      "axonflow_create_tenant_policy",
      "axonflow_explain_decision",
      "axonflow_get_cost_estimate",
      "axonflow_get_tenant_id",
      "axonflow_list_overrides",
      "axonflow_list_pro_features",
      "axonflow_list_recent_decisions",
      "axonflow_request_approval",
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      "[AxonFlow] Registered 9 agent-callable tools",
    );
  });

  it("logs a warning and skips tool registration on older OpenClaw runtimes", () => {
    const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    const api = {
      pluginConfig: {
        endpoint: "http://localhost:8080",
        clientId: "test",
        clientSecret: "secret",
      },
      logger,
      on: jest.fn(),
      // registerTool intentionally absent — simulates pre-2026.3.22 runtime
    };

    expect(() => registerAxonFlowGovernance(api)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw runtime does not expose registerTool"),
    );
  });

  describe("the startup warning for an unreachable endpoint names both switches (#196)", () => {
    async function warnFor(pluginConfig: Record<string, unknown>): Promise<string> {
      const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
      const api = { pluginConfig, logger, on: jest.fn(), registerTool: jest.fn() };
      registerAxonFlowGovernance(api);
      // The health check is fire-and-forget: let its fetch (a 503 here) settle.
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      const call = logger.warn.mock.calls.find((c: unknown[]) =>
        String(c[0]).startsWith("AxonFlow health check failed"),
      );
      return String(call?.[0] ?? "");
    }

    it("failMode open, onError block: tool calls run with the notice, messages are cancelled", async () => {
      const msg = await warnFor({ endpoint: "http://localhost:8080", clientId: "test", clientSecret: "secret" });
      expect(msg).toContain('governed tool calls run ungoverned, with a one-time notice (failMode "open")');
      expect(msg).toContain('outbound messages are cancelled (onError "block")');
      expect(msg).not.toContain("fail-closed");
    });

    it("failMode closed, onError allow: tool calls are blocked, messages are delivered", async () => {
      const msg = await warnFor({
        endpoint: "http://localhost:8080",
        clientId: "test",
        clientSecret: "secret",
        failMode: "closed",
        onError: "allow",
      });
      expect(msg).toContain('governed tool calls are blocked (failMode "closed")');
      expect(msg).toContain('outbound messages are delivered ungoverned (onError "allow")');
    });
  });

  it("rejects clientSecret without clientId regardless of mode", () => {
    // Defense against half-credentialled licensed setups: clientSecret on
    // its own is meaningless and almost always indicates a misconfiguration
    // where the deployment's tenant identity (AXONFLOW_CLIENT_ID) was
    // forgotten. Keep this hard error.
    const api = {
      pluginConfig: { clientSecret: "leftover-from-licensed-setup" },
      logger: { info: jest.fn(), error: jest.fn() },
      on: jest.fn(),
    };

    expect(() => registerAxonFlowGovernance(api)).toThrow(
      "'clientId' is required when 'clientSecret' is set",
    );
  });
});
