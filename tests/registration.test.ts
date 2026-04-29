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
