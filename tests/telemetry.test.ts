import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFileSync } from "fs";
import {
  ORG_ID_LOCAL_DEV_SENTINEL,
  sendTelemetryPing,
  telemetryOrgID,
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

  // ---- v9.1 org_id (#2277) ----

  describe("org_id (v9.1)", () => {
    it("emits ORG_ID env on the wire when set (operator-supplied)", async () => {
      process.env.ORG_ID = "acme-corp";
      await sendTelemetryPing(baseOptions);
      const checkpointCall = mockFetch.mock.calls.find(
        (call: unknown[]) => !(call[0] as string).endsWith("/health"),
      );
      const body = (checkpointCall![1] as RequestInit).body as string;
      expect(JSON.parse(body).org_id).toBe("acme-corp");
      // Wire-literal substring assertion defends against tag-removal mutations.
      expect(body).toContain('"org_id":"acme-corp"');
    });

    it("emits cs_<uuid> tenant_id from registration file when ORG_ID unset", async () => {
      // Write a synthetic registration file to the test-isolated config dir.
      const configDir = process.env.AXONFLOW_CONFIG_DIR!;
      fs.mkdirSync(configDir, { recursive: true });
      const regFile = path.join(configDir, "try-registration.json");
      const csId = "cs_e3a4b5c6-d7e8-4f90-a1b2-c3d4e5f6a7b8";
      fs.writeFileSync(
        regFile,
        JSON.stringify({ endpoint: "https://try.getaxonflow.com", tenant_id: csId, secret: "x" }),
        { mode: 0o600 },
      );
      await sendTelemetryPing(baseOptions);
      const checkpointCall = mockFetch.mock.calls.find(
        (call: unknown[]) => !(call[0] as string).endsWith("/health"),
      );
      const body = (checkpointCall![1] as RequestInit).body as string;
      expect(JSON.parse(body).org_id).toBe(csId);
      expect(body).toContain(`"org_id":"${csId}"`);
    });

    it("emits local-dev-org sentinel when no ORG_ID and no registration file", async () => {
      // Neither env nor registration file present (beforeEach wipes both).
      await sendTelemetryPing(baseOptions);
      const checkpointCall = mockFetch.mock.calls.find(
        (call: unknown[]) => !(call[0] as string).endsWith("/health"),
      );
      const body = (checkpointCall![1] as RequestInit).body as string;
      expect(JSON.parse(body).org_id).toBe("local-dev-org");
      expect(ORG_ID_LOCAL_DEV_SENTINEL).toBe("local-dev-org");
    });

    it("ORG_ID env wins over registration file (precedence contract)", async () => {
      const configDir = process.env.AXONFLOW_CONFIG_DIR!;
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "try-registration.json"),
        JSON.stringify({ tenant_id: "cs_from_file" }),
        { mode: 0o600 },
      );
      process.env.ORG_ID = "operator-override";
      await sendTelemetryPing(baseOptions);
      const checkpointCall = mockFetch.mock.calls.find(
        (call: unknown[]) => !(call[0] as string).endsWith("/health"),
      );
      const body = (checkpointCall![1] as RequestInit).body as string;
      expect(JSON.parse(body).org_id).toBe("operator-override");
    });

    it("telemetryOrgID helper directly: env precedence + sentinel fallback", () => {
      process.env.ORG_ID = "acme-corp";
      expect(telemetryOrgID()).toBe("acme-corp");
      process.env.ORG_ID = "";
      expect(telemetryOrgID()).toBe("local-dev-org");
      delete process.env.ORG_ID;
      expect(telemetryOrgID()).toBe("local-dev-org");
    });
  });

  // ---- license_tier (#3619) ----
  //
  // Two halves. The round-trip half proves the value the platform reports
  // reaches the wire unchanged. The fail-open half is the load-bearing one:
  // every way the probe can fail must leave the heartbeat delivered and the
  // key ABSENT — not "unknown", not null, not "". The receiver reads
  // key-absent as "this client did not report"; sending "unknown" would
  // instead assert that the platform answered and said it did not know.
  describe("license_tier (#3619)", () => {
    // Drives the real sendTelemetryPing against a /health that answers
    // however the case needs, and returns the captured heartbeat body.
    async function pingWithHealth(
      health: { ok?: boolean; json?: () => Promise<unknown> },
      options: Partial<typeof baseOptions> = {},
    ): Promise<Record<string, unknown>> {
      const fetchImpl = jest.fn().mockImplementation((url: string) => {
        if (typeof url === "string" && url.endsWith("/health")) {
          return Promise.resolve({
            ok: health.ok ?? true,
            json: health.json ?? (() => Promise.resolve({})),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      global.fetch = fetchImpl as unknown as typeof fetch;
      _resetTelemetryInFlightForTests();

      await sendTelemetryPing({ ...baseOptions, ...options });

      const checkpointCall = fetchImpl.mock.calls.find(
        (call: unknown[]) => !(call[0] as string).endsWith("/health"),
      );
      // Asserted on EVERY case: enrichment must never be able to suppress the
      // heartbeat it rides on.
      expect(checkpointCall).toBeDefined();
      const healthCalls = fetchImpl.mock.calls.filter((call: unknown[]) =>
        (call[0] as string).endsWith("/health"),
      );
      // license_tier rides the probe that already existed. A second round
      // trip would make it a new data collection rather than a new field.
      expect(healthCalls).toHaveLength(1);
      return JSON.parse((checkpointCall![1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
    }

    const healthWith = (tier: unknown, version: unknown = "10.3.0") => ({
      json: () => Promise.resolve({ status: "healthy", version, tier }),
    });

    // ---- round-trip: relayed verbatim, never interpreted ----

    it.each([
      ["Community"],
      ["community"], // community-mode builds default to the lowercase form
      ["Evaluation"],
      ["Professional"],
      ["Enterprise"],
      ["Plus"], // the csaas health endpoint serializes EnterprisePlus this way
      ["EnterprisePlus"],
      ["starting"], // transient pre-init state: a real answer, not an error
    ])("relays tier %s verbatim", async (tier) => {
      const body = await pingWithHealth(healthWith(tier));
      expect(body.license_tier).toBe(tier);
    });

    it("relays a tier this build has never heard of, rather than flattening it", async () => {
      // The receiver owns the canonical mapping. A client that collapsed an
      // unrecognised tier to "unknown" would make every tier issued after it
      // shipped indistinguishable from a broken one.
      const body = await pingWithHealth(healthWith("SovereignCloud"));
      expect(body.license_tier).toBe("SovereignCloud");
    });

    it("relays a tier at exactly the 64-character cap", async () => {
      const tier = "E".repeat(64);
      const body = await pingWithHealth(healthWith(tier));
      expect(body.license_tier).toBe(tier);
    });

    it("keeps license_tier, deployment_mode and endpoint_type as three distinct dimensions", async () => {
      // An Enterprise-licensed platform, reached over an arbitrary remote
      // host, classified self_hosted. Conflating any pair would collapse two
      // of these three values into one.
      const body = await pingWithHealth(healthWith("Enterprise"));
      expect(body.license_tier).toBe("Enterprise");
      expect(body.deployment_mode).toBe("self_hosted");
      expect(body.endpoint_type).toBe("remote");
    });

    it("does not disturb platform_version, which is read from the same body", async () => {
      const body = await pingWithHealth(healthWith("Enterprise", "9.16.0"));
      expect(body.platform_version).toBe("9.16.0");
      expect(body.license_tier).toBe("Enterprise");
    });

    // ---- fail open: the key is absent, and the heartbeat still ships ----

    it("omits the key when /health answers non-2xx, even if the error body carries a tier", async () => {
      const body = await pingWithHealth({ ok: false, ...healthWith("Enterprise") });
      expect(body).not.toHaveProperty("license_tier");
    });

    it("omits the key when the endpoint is unreachable", async () => {
      const fetchImpl = jest.fn().mockImplementation((url: string) => {
        if (typeof url === "string" && url.endsWith("/health")) {
          return Promise.reject(new Error("ECONNREFUSED"));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      global.fetch = fetchImpl as unknown as typeof fetch;
      _resetTelemetryInFlightForTests();

      await sendTelemetryPing(baseOptions);

      const checkpointCall = fetchImpl.mock.calls.find(
        (call: unknown[]) => !(call[0] as string).endsWith("/health"),
      );
      expect(checkpointCall).toBeDefined();
      const body = JSON.parse((checkpointCall![1] as RequestInit).body as string);
      expect(body).not.toHaveProperty("license_tier");
      expect(body.platform_version).toBeNull();
    });

    it("omits the key when the body is not valid JSON", async () => {
      const body = await pingWithHealth({
        json: () => Promise.reject(new SyntaxError("Unexpected token")),
      });
      expect(body).not.toHaveProperty("license_tier");
    });

    it("omits the key when /health returns no tier at all (older platform)", async () => {
      const body = await pingWithHealth({
        json: () => Promise.resolve({ status: "healthy", version: "9.16.0" }),
      });
      expect(body).not.toHaveProperty("license_tier");
      // The two fields are independent: losing the tier must not lose the
      // version signal the plugin already had.
      expect(body.platform_version).toBe("9.16.0");
    });

    // A required string arriving as another JSON type is invisible to any
    // decoder that coerces, so every wrong type is covered explicitly.
    it.each([
      ["null", null],
      ["a number", 42],
      ["a boolean", true],
      ["an object", { name: "Enterprise" }],
      ["an array", ["Enterprise"]],
      ["an empty string", ""],
    ])("omits the key when tier is %s", async (_label, tier) => {
      const body = await pingWithHealth(healthWith(tier));
      expect(body).not.toHaveProperty("license_tier");
    });

    // `typeof null === "object"` and an array is an object too; indexing
    // either yields undefined silently rather than failing.
    it.each([
      ["null", null],
      ["an array", [{ tier: "Enterprise" }]],
      ["a bare string", "Enterprise"],
      ["a number", 7],
    ])("omits the key when the whole body is %s", async (_label, payload) => {
      const body = await pingWithHealth({ json: () => Promise.resolve(payload) });
      expect(body).not.toHaveProperty("license_tier");
    });

    it("drops a tier one character past the cap whole, rather than truncating it", async () => {
      // A truncated value would be a tier the platform never reported.
      const body = await pingWithHealth(healthWith("E".repeat(65)));
      expect(body).not.toHaveProperty("license_tier");
    });

    it("serialises the absent case as a missing key, not null and not \"unknown\"", async () => {
      // The distinction survives JSON.stringify, which is the only form the
      // receiver ever sees.
      const fetchImpl = jest.fn().mockImplementation((url: string) => {
        if (typeof url === "string" && url.endsWith("/health")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: "10.3.0" }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      global.fetch = fetchImpl as unknown as typeof fetch;
      _resetTelemetryInFlightForTests();

      await sendTelemetryPing(baseOptions);

      const checkpointCall = fetchImpl.mock.calls.find(
        (call: unknown[]) => !(call[0] as string).endsWith("/health"),
      );
      const raw = (checkpointCall![1] as RequestInit).body as string;
      expect(raw).not.toContain("license_tier");
      expect(Object.keys(JSON.parse(raw))).not.toContain("license_tier");
    });
  });
});
