/**
 * Verify all public exports are accessible from the package entry point.
 */
import {
  AxonFlowClient,
  registerAxonFlowGovernance,
  resolveConfig,
  shouldGovernTool,
  deriveConnectorType,
  getMetrics,
  VERSION,
} from "../src/index.js";

describe("package exports", () => {
  it("exports AxonFlowClient", () => {
    expect(AxonFlowClient).toBeDefined();
    expect(typeof AxonFlowClient).toBe("function");
  });

  it("exports registerAxonFlowGovernance", () => {
    expect(registerAxonFlowGovernance).toBeDefined();
    expect(typeof registerAxonFlowGovernance).toBe("function");
  });

  it("exports resolveConfig", () => {
    expect(resolveConfig).toBeDefined();
    const config = resolveConfig({
      endpoint: "http://x",
      clientId: "id",
      clientSecret: "s",
    });
    expect(config.endpoint).toBe("http://x");
  });

  it("exports shouldGovernTool", () => {
    expect(shouldGovernTool).toBeDefined();
    expect(
      shouldGovernTool("tool", {
        endpoint: "",
        clientId: "",
        clientSecret: "",
      }),
    ).toBe(true);
  });

  it("exports deriveConnectorType", () => {
    expect(deriveConnectorType).toBeDefined();
    expect(deriveConnectorType("test")).toBe("openclaw.test");
  });

  it("exports getMetrics", () => {
    expect(getMetrics).toBeDefined();
    const m = getMetrics();
    expect(m.toolCallsEvaluated).toBeDefined();
  });

  it("exports VERSION", () => {
    expect(VERSION).toBeDefined();
    expect(typeof VERSION).toBe("string");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
