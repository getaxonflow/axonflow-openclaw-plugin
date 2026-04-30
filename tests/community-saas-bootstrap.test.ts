/**
 * Tests for the Community-SaaS first-run bootstrap.
 *
 * Branches that matter:
 *   - Fast path: cached registration is fresh → no network call.
 *   - Cached but world-readable → refuse + re-register.
 *   - Cached but expiring within REFRESH_WINDOW_MS → re-register.
 *   - 429 → backoff stamp written, source=rate-limited.
 *   - Backoff stamp present and unexpired → short-circuit, no fetch.
 *   - 201 with malformed body → source=failed, no file written.
 *   - 201 with valid body → file written 0600, source=fresh-registration.
 *   - Network failure → source=failed.
 *   - In-flight gate de-duplicates concurrent calls.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  bootstrapCommunitySaas,
  _resetBootstrapInFlightForTests,
} from "../src/community-saas-bootstrap.js";

const originalEnv = { ...process.env };

let testDir = "";
let configDir = "";
let cacheDir = "";
let registrationFile = "";
let backoffFile = "";

beforeEach(() => {
  process.env = { ...originalEnv };
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "axonflow-bootstrap-test-"));
  configDir = path.join(testDir, "cfg");
  cacheDir = path.join(testDir, "cache");
  process.env.AXONFLOW_CONFIG_DIR = configDir;
  process.env.AXONFLOW_CACHE_DIR = cacheDir;
  registrationFile = path.join(configDir, "try-registration.json");
  backoffFile = path.join(cacheDir, "openclaw-plugin-register-backoff");
  _resetBootstrapInFlightForTests();
});

afterEach(() => {
  process.env = originalEnv;
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

function makeFreshRegistration(overrides: Record<string, unknown> = {}): string {
  const futureIso = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  return JSON.stringify({
    tenant_id: "cs_abc123",
    secret: "secret-xyz",
    expires_at: futureIso,
    endpoint: "https://try.getaxonflow.com",
    ...overrides,
  });
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("bootstrapCommunitySaas", () => {
  describe("operator opt-out via AXONFLOW_COMMUNITY_SAAS", () => {
    it("short-circuits with source=opted-out when AXONFLOW_COMMUNITY_SAAS=0", async () => {
      process.env.AXONFLOW_COMMUNITY_SAAS = "0";
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(201, {}));
      const result = await bootstrapCommunitySaas({
        fetchImpl: fetchSpy as unknown as typeof fetch,
        pluginVersion: "1.0.0",
      });
      expect(result?.source).toBe("opted-out");
      expect(result?.clientId).toBe("");
      expect(result?.clientSecret).toBe("");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("short-circuits for 'false', 'off', 'no' values too", async () => {
      const fetchSpy = jest.fn();
      for (const value of ["false", "off", "no", "FALSE", "Off"]) {
        process.env.AXONFLOW_COMMUNITY_SAAS = value;
        _resetBootstrapInFlightForTests();
        const result = await bootstrapCommunitySaas({
          fetchImpl: fetchSpy as unknown as typeof fetch,
          pluginVersion: "1.0.0",
        });
        expect(result?.source).toBe("opted-out");
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("does NOT opt out when AXONFLOW_COMMUNITY_SAAS=1", async () => {
      process.env.AXONFLOW_COMMUNITY_SAAS = "1";
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(503, {}));
      const result = await bootstrapCommunitySaas({
        fetchImpl: fetchSpy as unknown as typeof fetch,
        pluginVersion: "1.0.0",
      });
      expect(result?.source).not.toBe("opted-out");
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe("first-load disclosure banner", () => {
    it("invokes the disclosureLogger before the registration fetch fires", async () => {
      const callLog: Array<{ kind: string; arg: unknown }> = [];
      const disclosureLogger = jest.fn((msg: string) => callLog.push({ kind: "log", arg: msg }));
      const fetchSpy = jest.fn().mockImplementation(async () => {
        callLog.push({ kind: "fetch", arg: null });
        return jsonResponse(201, {
          tenant_id: "cs_xyz",
          secret: "sec",
          expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        });
      });
      await bootstrapCommunitySaas({
        fetchImpl: fetchSpy as unknown as typeof fetch,
        pluginVersion: "1.0.0",
        disclosureLogger,
      });
      expect(disclosureLogger).toHaveBeenCalledTimes(1);
      const banner = (disclosureLogger.mock.calls[0]?.[0] ?? "") as string;
      expect(banner).toMatch(/Community SaaS/);
      expect(banner).toMatch(/AXONFLOW_COMMUNITY_SAAS=0/);
      // Order: log first, then fetch.
      const logIdx = callLog.findIndex((c) => c.kind === "log");
      const fetchIdx = callLog.findIndex((c) => c.kind === "fetch");
      expect(logIdx).toBeGreaterThanOrEqual(0);
      expect(fetchIdx).toBeGreaterThan(logIdx);
    });

    it("does not re-fire the banner on a subsequent run when the stamp exists", async () => {
      const disclosureLogger = jest.fn();
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(201, {
        tenant_id: "cs_xyz",
        secret: "sec",
        expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      }));
      // First call writes the disclosure stamp.
      await bootstrapCommunitySaas({
        fetchImpl: fetchSpy as unknown as typeof fetch,
        pluginVersion: "1.0.0",
        disclosureLogger,
      });
      expect(disclosureLogger).toHaveBeenCalledTimes(1);

      // Drop the cached registration so we go through the registration
      // path again, and reset the in-flight gate.
      try { fs.unlinkSync(registrationFile); } catch { /* fine */ }
      _resetBootstrapInFlightForTests();

      await bootstrapCommunitySaas({
        fetchImpl: fetchSpy as unknown as typeof fetch,
        pluginVersion: "1.0.0",
        disclosureLogger,
      });
      // Still 1 — second call did not re-warn.
      expect(disclosureLogger).toHaveBeenCalledTimes(1);
    });

    it("does NOT show the disclosure banner on the cached fast path", async () => {
      // Pre-populate a fresh cached registration; bootstrap should
      // fast-path-return without any disclosure logging or fetch.
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(registrationFile, makeFreshRegistration(), { mode: 0o600 });
      const disclosureLogger = jest.fn();
      const fetchSpy = jest.fn();
      const result = await bootstrapCommunitySaas({
        fetchImpl: fetchSpy as unknown as typeof fetch,
        pluginVersion: "1.0.0",
        disclosureLogger,
      });
      expect(result?.source).toBe("cached-registration");
      expect(disclosureLogger).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("falls back to stderr when no logger is supplied", async () => {
      const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(201, {
        tenant_id: "cs_xyz",
        secret: "sec",
        expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      }));
      try {
        await bootstrapCommunitySaas({
          fetchImpl: fetchSpy as unknown as typeof fetch,
          pluginVersion: "1.0.0",
          // disclosureLogger intentionally omitted
        });
        const calls = stderrSpy.mock.calls.map((args) => String(args[0]));
        const hadBanner = calls.some((s) => /Community SaaS/.test(s));
        expect(hadBanner).toBe(true);
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  it("returns failed when network errors and no cached registration is present", async () => {
    // Test isolation note: clearing AXONFLOW_CONFIG_DIR alone is not enough
    // because the OS-default resolver lands at ~/Library/Application
    // Support/axonflow on macOS, which on developer machines often holds
    // a real registration file. Pin AXONFLOW_CONFIG_DIR to the per-test
    // tmp dir set up in beforeEach so the cache-miss → fetch path is
    // exercised deterministically regardless of dev-machine state.
    // (configDir is the tmp dir from beforeEach; no registration file
    // exists there.)
    const result = await bootstrapCommunitySaas({
      fetchImpl: jest.fn().mockResolvedValue(jsonResponse(503, {})) as unknown as typeof fetch,
      pluginVersion: "1.0.0",
    });
    expect(result).not.toBeNull();
    expect(result?.source).toBe("failed");
  });

  it("fast path: returns cached registration when fresh and 0600", async () => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(registrationFile, makeFreshRegistration(), { mode: 0o600 });

    const fetchSpy = jest.fn();
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
      pluginVersion: "1.0.0",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result?.source).toBe("cached-registration");
    expect(result?.clientId).toBe("cs_abc123");
    expect(result?.clientSecret).toBe("secret-xyz");
  });

  it("refuses to use a world-readable registration file", async () => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(registrationFile, makeFreshRegistration(), { mode: 0o644 });
    // Re-chmod in case writeFileSync ignored mode.
    fs.chmodSync(registrationFile, 0o644);

    const fetchSpy = jest.fn().mockResolvedValueOnce(
      jsonResponse(201, {
        tenant_id: "cs_new",
        secret: "secret-new",
        expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      }),
    );
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
      pluginVersion: "1.0.0",
    });

    // Refuses cached → falls through to fresh registration.
    expect(fetchSpy).toHaveBeenCalled();
    expect(result?.source).toBe("fresh-registration");
    expect(result?.clientId).toBe("cs_new");
  });

  it("re-registers when cached registration expires within 30 days", async () => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      registrationFile,
      makeFreshRegistration({ expires_at: soon }),
      { mode: 0o600 },
    );

    const fetchSpy = jest.fn().mockResolvedValueOnce(
      jsonResponse(201, {
        tenant_id: "cs_refresh",
        secret: "secret-refresh",
        expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      }),
    );
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
      pluginVersion: "1.0.0",
    });

    expect(fetchSpy).toHaveBeenCalled();
    expect(result?.source).toBe("fresh-registration");
    expect(result?.clientId).toBe("cs_refresh");
  });

  it("ignores cached registration with malformed JSON", async () => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(registrationFile, "not json at all", { mode: 0o600 });

    const fetchSpy = jest.fn().mockResolvedValueOnce(
      jsonResponse(201, {
        tenant_id: "cs_a",
        secret: "secret-a",
        expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      }),
    );
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(result?.source).toBe("fresh-registration");
  });

  it("ignores cached registration with missing fields", async () => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      registrationFile,
      JSON.stringify({ tenant_id: "", secret: "x", expires_at: "2099-01-01" }),
      { mode: 0o600 },
    );

    const fetchSpy = jest.fn().mockResolvedValueOnce(
      jsonResponse(201, {
        tenant_id: "cs_b",
        secret: "secret-b",
        expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      }),
    );
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(result?.source).toBe("fresh-registration");
  });

  it("429 response writes backoff stamp and returns rate-limited", async () => {
    const fetchSpy = jest.fn().mockResolvedValueOnce(
      new Response("rate limited", { status: 429 }),
    );
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(result?.source).toBe("rate-limited");
    expect(fs.existsSync(backoffFile)).toBe(true);
    const stampMode = fs.statSync(backoffFile).mode & 0o777;
    expect(stampMode).toBe(0o600);
  });

  it("respects active backoff stamp without firing fetch", async () => {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const future = Math.floor(Date.now() / 1000) + 600; // 10 min ahead
    fs.writeFileSync(backoffFile, String(future), { mode: 0o600 });

    const fetchSpy = jest.fn();
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result?.source).toBe("rate-limited");
  });

  it("expired backoff stamp does NOT short-circuit", async () => {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const past = Math.floor(Date.now() / 1000) - 60;
    fs.writeFileSync(backoffFile, String(past), { mode: 0o600 });

    const fetchSpy = jest.fn().mockResolvedValueOnce(
      jsonResponse(201, {
        tenant_id: "cs_c",
        secret: "secret-c",
        expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      }),
    );
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(fetchSpy).toHaveBeenCalled();
    expect(result?.source).toBe("fresh-registration");
  });

  it("malformed backoff stamp content is ignored", async () => {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(backoffFile, "not-a-number", { mode: 0o600 });

    const fetchSpy = jest.fn().mockResolvedValueOnce(
      jsonResponse(201, {
        tenant_id: "cs_d",
        secret: "secret-d",
        expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      }),
    );
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(fetchSpy).toHaveBeenCalled();
    expect(result?.source).toBe("fresh-registration");
  });

  it("non-201, non-429 response returns failed", async () => {
    const fetchSpy = jest.fn().mockResolvedValueOnce(
      new Response("server error", { status: 503 }),
    );
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(result?.source).toBe("failed");
    expect(fs.existsSync(registrationFile)).toBe(false);
  });

  it("network failure returns failed", async () => {
    const fetchSpy = jest.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(result?.source).toBe("failed");
    expect(fs.existsSync(registrationFile)).toBe(false);
  });

  it("201 with malformed body returns failed and writes nothing", async () => {
    const fetchSpy = jest.fn().mockResolvedValueOnce(
      jsonResponse(201, { tenant_id: "" }),
    );
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(result?.source).toBe("failed");
    expect(fs.existsSync(registrationFile)).toBe(false);
  });

  it("201 with non-JSON body returns failed", async () => {
    const fetchSpy = jest.fn().mockResolvedValueOnce(
      new Response("not json", { status: 201 }),
    );
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(result?.source).toBe("failed");
  });

  it("201 with valid body persists 0600 file and clears backoff stamp", async () => {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const past = Math.floor(Date.now() / 1000) - 60;
    fs.writeFileSync(backoffFile, String(past), { mode: 0o600 });

    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    const fetchSpy = jest.fn().mockResolvedValueOnce(
      jsonResponse(201, {
        tenant_id: "cs_e",
        secret: "secret-e",
        expires_at: future,
        endpoint: "https://try.getaxonflow.com",
      }),
    );
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
      pluginVersion: "9.9.9",
    });

    expect(result?.source).toBe("fresh-registration");
    expect(result?.clientId).toBe("cs_e");
    expect(fs.existsSync(registrationFile)).toBe(true);
    const stampMode = fs.statSync(registrationFile).mode & 0o777;
    expect(stampMode).toBe(0o600);
    // Backoff stamp removed after successful registration.
    expect(fs.existsSync(backoffFile)).toBe(false);
  });

  it("uses default endpoint when response omits endpoint field", async () => {
    const fetchSpy = jest.fn().mockResolvedValueOnce(
      jsonResponse(201, {
        tenant_id: "cs_f",
        secret: "secret-f",
        expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      }),
    );
    const result = await bootstrapCommunitySaas({
      fetchImpl: fetchSpy as unknown as typeof fetch,
      endpoint: "https://override.example.com",
    });
    expect(result?.endpoint).toBe("https://override.example.com");
  });

  it("in-flight gate de-duplicates concurrent calls", async () => {
    let resolveFn: ((r: Response) => void) | null = null;
    const pending = new Promise<Response>((r) => { resolveFn = r; });
    const fetchSpy = jest.fn().mockReturnValue(pending);

    const p1 = bootstrapCommunitySaas({ fetchImpl: fetchSpy as unknown as typeof fetch });
    const p2 = bootstrapCommunitySaas({ fetchImpl: fetchSpy as unknown as typeof fetch });

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveFn!(
      jsonResponse(201, {
        tenant_id: "cs_g",
        secret: "secret-g",
        expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      }),
    );
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1?.clientId).toBe("cs_g");
    expect(r2?.clientId).toBe("cs_g");
  });
});
