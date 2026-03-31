import { registerAxonFlowGovernance } from "../src/index.js";

// Mock fetch for AxonFlowClient
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe("registerAxonFlowGovernance", () => {
  it("registers all six hooks", () => {
    const hooks: Array<{ event: string; handler: unknown; priority?: number }> = [];
    const api = {
      pluginConfig: {
        endpoint: "http://localhost:8080",
        clientId: "test",
        clientSecret: "secret",
      },
      logger: { info: jest.fn(), error: jest.fn() },
      registerHook: jest.fn((event: string | string[], handler: unknown, opts?: { priority?: number }) => {
        const eventStr = Array.isArray(event) ? event.join(",") : event;
        hooks.push({ event: eventStr, handler, priority: opts?.priority });
      }),
    };

    registerAxonFlowGovernance(api);

    expect(api.registerHook).toHaveBeenCalledTimes(6);
    expect(hooks[0]?.event).toBe("before_tool_call");
    expect(hooks[0]?.priority).toBe(10);
    expect(hooks[1]?.event).toBe("tool_result_persist");
    expect(hooks[1]?.priority).toBe(10);
    expect(hooks[2]?.event).toBe("after_tool_call");
    expect(hooks[2]?.priority).toBe(90);
    expect(hooks[3]?.event).toBe("message_sending");
    expect(hooks[3]?.priority).toBe(10);
    expect(hooks[4]?.event).toBe("llm_input");
    expect(hooks[4]?.priority).toBe(90);
    expect(hooks[5]?.event).toBe("llm_output");
    expect(hooks[5]?.priority).toBe(90);
  });

  it("logs configuration on startup", () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const api = {
      pluginConfig: {
        endpoint: "http://localhost:8080",
        clientId: "test",
        clientSecret: "secret",
        highRiskTools: ["web_fetch", "message"],
      },
      logger,
      registerHook: jest.fn(),
    };

    registerAxonFlowGovernance(api);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("endpoint=http://localhost:8080"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("web_fetch,message"),
    );
  });

  it("throws on missing config", () => {
    const api = {
      pluginConfig: undefined,
      logger: { info: jest.fn(), error: jest.fn() },
      registerHook: jest.fn(),
    };

    expect(() => registerAxonFlowGovernance(api)).toThrow("requires configuration");
  });

  it("throws on missing endpoint", () => {
    const api = {
      pluginConfig: { clientId: "test", clientSecret: "secret" },
      logger: { info: jest.fn(), error: jest.fn() },
      registerHook: jest.fn(),
    };

    expect(() => registerAxonFlowGovernance(api)).toThrow("'endpoint' is required");
  });
});
