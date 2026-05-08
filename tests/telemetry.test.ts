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
  delete process.env.AXONFLOW_TRY;

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
    expect(body.telemetry_type).toBe("plugin");
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
    // v1 telemetry-schema fields
    expect(body.endpoint_type).toBe("remote");
    expect(body.deployment_mode).toBe("self_hosted");
    // `profile` field intentionally absent — collided with the governance
    // `AXONFLOW_PROFILE` env var (platform/agent/profile.go) and was
    // dropped from v1 before any tag shipped (#2033).
    expect(body.profile).toBeUndefined();
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

  // ---- Deployment mode (v1 schema: self_hosted | community_saas | unknown) ----

  it("sets deployment_mode=self_hosted for an arbitrary remote endpoint", async () => {
    // v1 schema collapses the prior production/development split. The
    // dimension now reflects deployment topology only — onError is no
    // longer a deployment-mode signal.
    await sendTelemetryPing(baseOptions);

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.deployment_mode).toBe("self_hosted");
  });

  it("self_hosted regardless of onError=allow (v1 onError-independence)", async () => {
    await sendTelemetryPing({ ...baseOptions, onError: "allow" });

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.deployment_mode).toBe("self_hosted");
  });

  it("sets deployment_mode=community_saas when endpoint is *.try.getaxonflow.com", async () => {
    await sendTelemetryPing({ ...baseOptions, endpoint: "https://try.getaxonflow.com" });

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.deployment_mode).toBe("community_saas");
  });

  it("sets deployment_mode=community_saas when AXONFLOW_TRY=1 even on a custom host", async () => {
    process.env.AXONFLOW_TRY = "1";
    await sendTelemetryPing({ ...baseOptions, endpoint: "https://my-proxy.example.com" });

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.deployment_mode).toBe("community_saas");
  });

  it("sets deployment_mode=unknown when endpoint is empty/unparseable", async () => {
    await sendTelemetryPing({ ...baseOptions, endpoint: "not a url" });

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.deployment_mode).toBe("unknown");
  });

  // ---- Endpoint type (v1 schema: localhost | private_network | remote | unknown) ----

  it("sets endpoint_type=localhost for http://localhost:8080", async () => {
    await sendTelemetryPing({ ...baseOptions, endpoint: "http://localhost:8080" });

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.endpoint_type).toBe("localhost");
  });

  it("sets endpoint_type=private_network for an RFC1918 host", async () => {
    await sendTelemetryPing({ ...baseOptions, endpoint: "http://10.0.0.5:8080" });

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.endpoint_type).toBe("private_network");
  });

  it("sets endpoint_type=remote for a generic public hostname", async () => {
    await sendTelemetryPing(baseOptions);

    const checkpointCall = mockFetch.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).endsWith("/health"),
    );
    const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
    expect(body.endpoint_type).toBe("remote");
  });

  // ---- Error resilience ----

  it("silently handles fetch failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));
    await expect(sendTelemetryPing(baseOptions)).resolves.toBeUndefined();
  });
});
