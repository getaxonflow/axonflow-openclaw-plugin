import { sendTelemetryPing } from "../src/telemetry.js";
import { VERSION } from "../src/index.js";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

const mockFetch = jest.fn().mockImplementation((url: string) => {
  if (typeof url === "string" && url.endsWith("/health")) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ status: "healthy", version: "5.5.0" }),
    });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
});

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.DO_NOT_TRACK;
  delete process.env.AXONFLOW_TELEMETRY;
  delete process.env.AXONFLOW_CHECKPOINT_URL;
  global.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockClear();
});

afterEach(() => {
  process.env = originalEnv;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("VERSION constant", () => {
  it("matches package.json version", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkgVersion = require("../package.json").version;
    expect(VERSION).toBe(pkgVersion);
  });
});

describe("sendTelemetryPing", () => {
  const baseOptions = {
    endpoint: "https://axonflow.example.com",
    pluginVersion: "0.2.0",
    hookCount: 5,
    highRiskToolCount: 2,
    onError: "block",
  };

  it("sends telemetry ping to checkpoint endpoint", async () => {
    sendTelemetryPing(baseOptions);
    // Wait for fire-and-forget async
    await new Promise((r) => setTimeout(r, 100));

    // Should call /health first, then checkpoint
    expect(mockFetch).toHaveBeenCalled();
    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    expect(checkpointCall).toBeDefined();

    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.sdk).toBe("openclaw-plugin");
    expect(body.sdk_version).toBe("0.2.0");
    expect(body.features).toContain("hooks:5");
    expect(body.features).toContain("high_risk_tools:2");
    expect(body.features).toContain("on_error:block");
    expect(body.instance_id).toBeDefined();
    expect(body.os).toBeDefined();
    expect(body.arch).toBeDefined();
    expect(body.runtime_version).toBeDefined();
  });

  it("does not send when DO_NOT_TRACK=1", () => {
    process.env.DO_NOT_TRACK = "1";
    sendTelemetryPing(baseOptions);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not send when AXONFLOW_TELEMETRY=off", () => {
    process.env.AXONFLOW_TELEMETRY = "off";
    sendTelemetryPing(baseOptions);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not send for localhost endpoints", () => {
    sendTelemetryPing({ ...baseOptions, endpoint: "http://localhost:8080" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not send for 127.0.0.1 endpoints", () => {
    sendTelemetryPing({ ...baseOptions, endpoint: "http://127.0.0.1:8080" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses custom checkpoint URL from env", async () => {
    process.env.AXONFLOW_CHECKPOINT_URL = "https://custom.checkpoint.example.com/v1/ping";
    sendTelemetryPing(baseOptions);
    await new Promise((r) => setTimeout(r, 100));

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes("custom.checkpoint"),
    );
    expect(checkpointCall).toBeDefined();
  });

  it("detects platform version from health endpoint", async () => {
    sendTelemetryPing(baseOptions);
    await new Promise((r) => setTimeout(r, 100));

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.platform_version).toBe("5.5.0");
  });

  it("sets deployment_mode based on onError", async () => {
    sendTelemetryPing({ ...baseOptions, onError: "allow" });
    await new Promise((r) => setTimeout(r, 100));

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.deployment_mode).toBe("development");
  });

  it("silently handles fetch failure", () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));
    expect(() => sendTelemetryPing(baseOptions)).not.toThrow();
  });
});
