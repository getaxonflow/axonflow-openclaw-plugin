import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFileSync } from "fs";
import {
  sendTelemetryPing,
  _resetTelemetryInFlightForTests,
} from "../src/telemetry.js";
import { VERSION } from "../src/index.js";

const packageJson = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

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

let testHome = "";

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.DO_NOT_TRACK;
  delete process.env.AXONFLOW_TELEMETRY;
  delete process.env.AXONFLOW_CHECKPOINT_URL;

  // Each test gets an isolated cache/config dir so on-disk state from a
  // prior test never silences the heartbeat in the next. We can't just set
  // HOME — os.homedir() on macOS reads from getpwuid(2) and ignores
  // process.env.HOME — so we use the explicit AXONFLOW_CACHE_DIR /
  // AXONFLOW_CONFIG_DIR overrides exposed by cache-dir.ts.
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), "axonflow-telemetry-test-"));
  process.env.AXONFLOW_CACHE_DIR = path.join(testHome, "cache");
  process.env.AXONFLOW_CONFIG_DIR = path.join(testHome, "config");
  delete process.env.XDG_CACHE_HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.LOCALAPPDATA;
  delete process.env.APPDATA;

  global.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockClear();
  _resetTelemetryInFlightForTests();
});

afterEach(() => {
  process.env = originalEnv;
  if (testHome) {
    fs.rmSync(testHome, { recursive: true, force: true });
    testHome = "";
  }
  jest.restoreAllMocks();
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("VERSION constant", () => {
  it("matches package.json version", () => {
    expect(VERSION).toBe(packageJson.version);
  });
});

describe("sendTelemetryPing", () => {
  const baseOptions = {
    endpoint: "https://axonflow.example.com",
    pluginVersion: VERSION,
    hookCount: 5,
    highRiskToolCount: 2,
    onError: "block",
    mode: "self-hosted",
  };

  it("sends telemetry ping with correct payload", async () => {
    await sendTelemetryPing(baseOptions);

    expect(mockFetch).toHaveBeenCalled();
    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    expect(checkpointCall).toBeDefined();

    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.sdk).toBe("openclaw-plugin");
    expect(body.sdk_version).toBe(VERSION);
    expect(body.features).toContain("hooks:5");
    expect(body.features).toContain("high_risk_tools:2");
    expect(body.features).toContain("on_error:block");
    expect(body.features).toContain("mode:self-hosted");
    expect(body.instance_id).toBeDefined();
    expect(body.os).toBeDefined();
    expect(body.arch).toBeDefined();
    expect(body.runtime_version).toBeDefined();
  });

  // ---- Opt-out tests ----

  it("STILL sends when only DO_NOT_TRACK=1 is set (DNT no longer honored)", async () => {
    process.env.DO_NOT_TRACK = "1";
    await sendTelemetryPing(baseOptions);
    expect(mockFetch).toHaveBeenCalled();
  });

  it("does not send when AXONFLOW_TELEMETRY=off", async () => {
    process.env.AXONFLOW_TELEMETRY = "off";
    await sendTelemetryPing(baseOptions);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not send when AXONFLOW_TELEMETRY=off, even with DO_NOT_TRACK=1 also set", async () => {
    process.env.DO_NOT_TRACK = "1";
    process.env.AXONFLOW_TELEMETRY = "off";
    await sendTelemetryPing(baseOptions);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("emits NO console.warn for DO_NOT_TRACK (no deprecation noise)", async () => {
    process.env.DO_NOT_TRACK = "1";
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    await sendTelemetryPing(baseOptions);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // ---- Localhost behavior ----

  it("sends telemetry for localhost endpoints by default", async () => {
    await sendTelemetryPing({ ...baseOptions, endpoint: "http://localhost:8080" });

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    expect(checkpointCall).toBeDefined();
  });

  // ---- Custom checkpoint URL ----

  it("uses custom checkpoint URL from env", async () => {
    process.env.AXONFLOW_CHECKPOINT_URL = "https://custom.checkpoint.example.com/v1/ping";
    await sendTelemetryPing(baseOptions);

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes("custom.checkpoint"),
    );
    expect(checkpointCall).toBeDefined();
  });

  // ---- Platform version detection ----

  it("detects platform version from health endpoint", async () => {
    await sendTelemetryPing(baseOptions);

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.platform_version).toBe("5.5.0");
  });

  // ---- Deployment mode ----

  it("sets deployment_mode=production when self-hosted with onError=block", async () => {
    await sendTelemetryPing(baseOptions);

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.deployment_mode).toBe("production");
  });

  it("sets deployment_mode=development when self-hosted with onError=allow", async () => {
    await sendTelemetryPing({ ...baseOptions, onError: "allow" });

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.deployment_mode).toBe("development");
  });

  it("sets deployment_mode=community-saas when mode=community-saas, regardless of onError", async () => {
    // Community-SaaS users would otherwise be hidden inside "production"
    // (because plugin-generated auth is present and onError defaults to block).
    // The deployment_mode field must reflect that they are first-class
    // Community-SaaS users, not self-hosted production users.
    await sendTelemetryPing({ ...baseOptions, mode: "community-saas" });

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.deployment_mode).toBe("community-saas");
    expect(body.features).toContain("mode:community-saas");
  });

  // ---- Error resilience ----

  it("silently handles fetch failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));
    await expect(sendTelemetryPing(baseOptions)).resolves.toBeUndefined();
  });
});
