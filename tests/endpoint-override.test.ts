/**
 * AXONFLOW_ENDPOINT override — governance-runtime resolution (#162).
 *
 * Through v2.8.3 the documented `env > pluginConfig > default` endpoint
 * precedence was honoured only by the status display; `resolveConfig`
 * (which feeds AxonFlowClient, i.e. every governed call) read
 * pluginConfig.endpoint alone. These tests pin the fixed contract:
 *
 *   1. env wins over pluginConfig;
 *   2. pluginConfig alone still works;
 *   3. neither → Community-SaaS default + community-saas mode;
 *   4. an env-provided endpoint counts as USER-PROVIDED for the
 *      deployment-mode classifier → self-hosted mode, and the
 *      registration path (register flow) never fires;
 *   5. empty / whitespace-only env values are ignored;
 *   6. the status surface resolves the SAME endpoint as the runtime
 *      (single shared helper — the drift that produced the false
 *      "status shows my endpoint" confirmation cannot recur).
 */

import { resolveConfig } from "../src/config.js";
import { resolveEndpointOverride, endpointFromEnv } from "../src/endpoint-env.js";
import { resolveStatusInputs, buildStatusReport } from "../src/status.js";
import { registerAxonFlowGovernance } from "../src/index.js";

const ENV_KEY = "AXONFLOW_ENDPOINT";
const savedEnv = process.env[ENV_KEY];

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = savedEnv;
  }
});

beforeEach(() => {
  delete process.env[ENV_KEY];
});

describe("resolveEndpointOverride (shared helper)", () => {
  it("returns the trimmed env value when set", () => {
    process.env[ENV_KEY] = "  https://axonflow.internal.example:8443  ";
    expect(resolveEndpointOverride("http://from-config:8080")).toBe(
      "https://axonflow.internal.example:8443",
    );
  });

  it("falls back to the trimmed pluginConfig value when env is unset", () => {
    expect(resolveEndpointOverride("  http://from-config:8080  ")).toBe(
      "http://from-config:8080",
    );
  });

  it("treats empty and whitespace-only env values as unset", () => {
    process.env[ENV_KEY] = "";
    expect(resolveEndpointOverride("http://from-config:8080")).toBe(
      "http://from-config:8080",
    );
    process.env[ENV_KEY] = "   ";
    expect(resolveEndpointOverride("http://from-config:8080")).toBe(
      "http://from-config:8080",
    );
  });

  it("returns '' when neither source provides a value", () => {
    expect(resolveEndpointOverride(undefined)).toBe("");
    expect(resolveEndpointOverride("")).toBe("");
    expect(resolveEndpointOverride("   ")).toBe("");
    expect(resolveEndpointOverride(42)).toBe("");
  });

  it("endpointFromEnv is a raw read (undefined when unset)", () => {
    expect(endpointFromEnv()).toBeUndefined();
    process.env[ENV_KEY] = "http://x";
    expect(endpointFromEnv()).toBe("http://x");
  });
});

describe("resolveConfig endpoint precedence (#162)", () => {
  it("env wins over pluginConfig.endpoint", () => {
    process.env[ENV_KEY] = "https://selfhosted.example:9443";
    const config = resolveConfig({ endpoint: "http://from-config:8080" });
    expect(config.endpoint).toBe("https://selfhosted.example:9443");
    expect(config.mode).toBe("self-hosted");
  });

  it("pluginConfig.endpoint alone is honoured (no env)", () => {
    const config = resolveConfig({ endpoint: "http://from-config:8080" });
    expect(config.endpoint).toBe("http://from-config:8080");
    expect(config.mode).toBe("self-hosted");
  });

  it("neither env nor pluginConfig → Community-SaaS default + community-saas mode", () => {
    const config = resolveConfig({});
    expect(config.endpoint).toBe("https://try.getaxonflow.com");
    expect(config.mode).toBe("community-saas");
  });

  it("env-provided endpoint counts as user-provided → self-hosted mode", () => {
    // The operator configured NOTHING in pluginConfig — the endpoint
    // arrives via the environment only. The classifier must select
    // self-hosted: no Community-SaaS auto-registration, clientId default.
    process.env[ENV_KEY] = "https://axonflow.corp.example";
    const config = resolveConfig({});
    expect(config.mode).toBe("self-hosted");
    expect(config.endpoint).toBe("https://axonflow.corp.example");
    expect(config.clientId).toBe("community");
    expect(config.clientSecret).toBe("");
  });

  it("credentials-only config pins the runtime endpoint to the localhost default", () => {
    const cfg = resolveConfig({ clientId: "t", clientSecret: "s" });
    expect(cfg.endpoint).toBe("http://localhost:8080");
    expect(cfg.mode).toBe("self-hosted");
  });

  it("empty env is ignored: pluginConfig then default apply", () => {
    process.env[ENV_KEY] = "";
    expect(resolveConfig({ endpoint: "http://cfg:1" }).endpoint).toBe("http://cfg:1");
    const config = resolveConfig({});
    expect(config.endpoint).toBe("https://try.getaxonflow.com");
    expect(config.mode).toBe("community-saas");
  });

  it("whitespace-only env is ignored (does not force self-hosted mode)", () => {
    process.env[ENV_KEY] = "   ";
    const config = resolveConfig({});
    expect(config.mode).toBe("community-saas");
    expect(config.endpoint).toBe("https://try.getaxonflow.com");
  });

  it("env value is trimmed before use", () => {
    process.env[ENV_KEY] = "  http://padded.example:8080  ";
    expect(resolveConfig({}).endpoint).toBe("http://padded.example:8080");
  });
});

describe("registration path with env-only endpoint (#162)", () => {
  const mockFetch = jest.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response("", { status: 503 }));
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("env-only endpoint: canary reports self-hosted and no traffic targets the Community-SaaS default", () => {
    process.env[ENV_KEY] = "http://sentinel.internal.example:9090";
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    registerAxonFlowGovernance({
      pluginConfig: {}, // nothing configured — the env var is the ONLY source
      logger,
      on: jest.fn(),
    });

    const canary = logger.info.mock.calls
      .map((c) => String(c[0] ?? ""))
      .find((line) => line.startsWith("[AxonFlow] Connected to AxonFlow at "));
    expect(canary).toBe(
      "[AxonFlow] Connected to AxonFlow at http://sentinel.internal.example:9090 (mode=self-hosted)",
    );

    // Outbound traffic must never hit the Community-SaaS default when the
    // operator pointed the plugin elsewhere via the environment — that was
    // the #162 failure: governed traffic on try.getaxonflow.com while
    // status displayed the override.
    for (const call of mockFetch.mock.calls) {
      const url = call[0];
      if (typeof url === "string") {
        expect(new URL(url).host).not.toBe("try.getaxonflow.com");
      }
    }
  });
});

describe("status ↔ runtime endpoint coherence (#162)", () => {
  it("status resolves the SAME endpoint as the governance runtime for every source combination", () => {
    const combos: Array<{ env?: string; pluginConfig: Record<string, unknown> }> = [
      { env: "https://env.example", pluginConfig: { endpoint: "http://cfg.example" } },
      { env: "https://env.example", pluginConfig: {} },
      { pluginConfig: { endpoint: "http://cfg.example" } },
      { pluginConfig: {} },
      { env: "   ", pluginConfig: { endpoint: "http://cfg.example" } },
      // Credentials but no endpoint: the runtime targets the canonical
      // local-agent default — status must display the same, not the
      // Community-SaaS URL (same doc-vs-display class as the env bug).
      { pluginConfig: { clientId: "tenant-x", clientSecret: "sec" } },
      { env: "https://env.example", pluginConfig: { clientId: "tenant-x", clientSecret: "sec" } },
    ];
    for (const combo of combos) {
      delete process.env[ENV_KEY];
      if (combo.env !== undefined) process.env[ENV_KEY] = combo.env;

      const runtimeEndpoint = resolveConfig(combo.pluginConfig).endpoint;
      const statusInputs = resolveStatusInputs(combo.pluginConfig, "/nonexistent-dir");
      const statusEndpoint = buildStatusReport(statusInputs).endpoint;

      expect(statusEndpoint).toBe(runtimeEndpoint);
    }
  });
});
