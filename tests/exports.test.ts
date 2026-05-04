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
  // W3 recovery surface — must remain accessible from the package entry
  // so the bin/ runner and external integrations can drive the flow.
  requestRecovery,
  verifyRecovery,
  extractRecoveryToken,
  persistRecoveredCredentials,
  RECOVERY_DEFAULT_ENDPOINT,
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
        mode: "community-saas",
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

  it("exports W3 recovery surface", () => {
    expect(typeof requestRecovery).toBe("function");
    expect(typeof verifyRecovery).toBe("function");
    expect(typeof extractRecoveryToken).toBe("function");
    expect(typeof persistRecoveredCredentials).toBe("function");
    expect(typeof RECOVERY_DEFAULT_ENDPOINT).toBe("string");
    expect(RECOVERY_DEFAULT_ENDPOINT).toMatch(/^https?:\/\//);
  });
});
