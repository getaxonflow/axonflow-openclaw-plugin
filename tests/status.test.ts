/**
 * Unit tests for the W4 status surface (src/status.ts).
 *
 * Coverage:
 *   - redactLicenseToken: short tokens, long tokens, empty / whitespace,
 *     undefined / null, full-token absence in output (codex-plugin#41).
 *   - readPersistedTenantId: missing file, malformed JSON, missing field,
 *     happy path, type mismatch.
 *   - resolveStatusInputs: env precedence over pluginConfig, whitespace
 *     trimming, env-only resolution, pluginConfig fallback.
 *   - buildStatusReport: free vs Pro tier, registered vs unregistered,
 *     endpoint default, upgrade URL default, registration_present flag.
 *   - formatStatusReport: includes tenant_id when present, includes
 *     recovery hint when missing, NEVER prints the full license token,
 *     prints redacted preview only.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildStatusReport,
  formatStatusReport,
  readPersistedTenantId,
  redactLicenseToken,
  resolveStatusInputs,
  STATUS_DEFAULT_ENDPOINT,
  STATUS_DEFAULT_UPGRADE_URL,
} from "../src/status.js";

describe("redactLicenseToken", () => {
  it("returns null for undefined", () => {
    expect(redactLicenseToken(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(redactLicenseToken(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(redactLicenseToken("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(redactLicenseToken("   \t\n  ")).toBeNull();
  });

  it("redacts a long token to last 4 chars with leading ellipsis", () => {
    const token = "AXON-eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ0ZW5hbnQifQ.signature1234ABCD";
    const out = redactLicenseToken(token);
    expect(out).toBe("…ABCD");
  });

  it("never includes more than the last 4 chars of the original token", () => {
    // Per codex-plugin#41 — the failure mode was printing the full token
    // in human-readable status output. Lock the redaction shape so a
    // future refactor can't widen the leak surface.
    const token = "AXON-PRO-LICENSE-TOKEN-VERY-SECRET-DATA-HERE-XYZ9";
    const out = redactLicenseToken(token);
    expect(out).not.toContain("AXON");
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("PRO-LICENSE");
    // The only allowable leak is the literal trailing 4 chars.
    expect(out).toBe("…XYZ9");
    // Output length is bounded: ellipsis + 4 chars = 5 codepoints.
    expect(out!.length).toBeLessThanOrEqual(5);
  });

  it("handles tokens shorter than 4 chars without padding", () => {
    expect(redactLicenseToken("ab")).toBe("…ab");
    expect(redactLicenseToken("a")).toBe("…a");
  });

  it("trims whitespace before redacting", () => {
    expect(redactLicenseToken("  abcdEFGH1234  ")).toBe("…1234");
  });
});

describe("readPersistedTenantId", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axonflow-status-test-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns null when the file does not exist", () => {
    expect(readPersistedTenantId(path.join(tmpDir, "missing.json"))).toBeNull();
  });

  it("returns null when the file is not valid JSON", () => {
    const file = path.join(tmpDir, "bad.json");
    fs.writeFileSync(file, "not json {{{");
    expect(readPersistedTenantId(file)).toBeNull();
  });

  it("returns null when tenant_id is missing", () => {
    const file = path.join(tmpDir, "no-tenant.json");
    fs.writeFileSync(file, JSON.stringify({ secret: "s", endpoint: "https://x" }));
    expect(readPersistedTenantId(file)).toBeNull();
  });

  it("returns null when tenant_id is the wrong type", () => {
    const file = path.join(tmpDir, "wrong-type.json");
    fs.writeFileSync(file, JSON.stringify({ tenant_id: 12345 }));
    expect(readPersistedTenantId(file)).toBeNull();
  });

  it("returns null when tenant_id is an empty string", () => {
    const file = path.join(tmpDir, "empty-tenant.json");
    fs.writeFileSync(file, JSON.stringify({ tenant_id: "" }));
    expect(readPersistedTenantId(file)).toBeNull();
  });

  it("returns the tenant_id on a well-formed file", () => {
    const file = path.join(tmpDir, "good.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        tenant_id: "cs_tenant_abc123",
        secret: "secret-value",
        expires_at: "2026-12-01T00:00:00Z",
        endpoint: "https://try.getaxonflow.com",
      }),
    );
    expect(readPersistedTenantId(file)).toBe("cs_tenant_abc123");
  });
});

describe("resolveStatusInputs", () => {
  // Snapshot + restore env between tests so we don't leak state into the
  // rest of the suite. This is the same pattern recover.test.ts uses.
  const ENV_KEYS = [
    "AXONFLOW_LICENSE_TOKEN",
    "AXONFLOW_ENDPOINT",
    "AXONFLOW_UPGRADE_URL",
  ] as const;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it("resolves all fields to undefined when env + pluginConfig are empty", () => {
    const inputs = resolveStatusInputs();
    expect(inputs.licenseToken).toBeUndefined();
    expect(inputs.endpoint).toBeUndefined();
    expect(inputs.upgradeUrl).toBeUndefined();
  });

  it("env wins over pluginConfig for licenseToken", () => {
    process.env.AXONFLOW_LICENSE_TOKEN = "env-token";
    const inputs = resolveStatusInputs({ licenseToken: "cfg-token" });
    expect(inputs.licenseToken).toBe("env-token");
  });

  it("falls back to pluginConfig when env is unset", () => {
    const inputs = resolveStatusInputs({ licenseToken: "cfg-token" });
    expect(inputs.licenseToken).toBe("cfg-token");
  });

  it("treats whitespace-only env values as unset", () => {
    process.env.AXONFLOW_LICENSE_TOKEN = "   ";
    const inputs = resolveStatusInputs({ licenseToken: "cfg-token" });
    expect(inputs.licenseToken).toBe("cfg-token");
  });

  it("trims whitespace around resolved values", () => {
    process.env.AXONFLOW_ENDPOINT = "  https://x.test  ";
    const inputs = resolveStatusInputs();
    expect(inputs.endpoint).toBe("https://x.test");
  });

  it("propagates upgrade URL from env", () => {
    process.env.AXONFLOW_UPGRADE_URL = "https://corp.example/buy";
    const inputs = resolveStatusInputs();
    expect(inputs.upgradeUrl).toBe("https://corp.example/buy");
  });

  it("forwards configDirOverride when supplied", () => {
    const inputs = resolveStatusInputs(undefined, "/tmp/test-cfg");
    expect(inputs.configDirOverride).toBe("/tmp/test-cfg");
  });
});

describe("buildStatusReport", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axonflow-status-build-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("reports free tier when no license token is set", () => {
    const report = buildStatusReport({ configDirOverride: tmpDir });
    expect(report.tier).toBe("free");
    expect(report.license_token_preview).toBeNull();
  });

  it("reports Pro tier with redacted preview when license token is set", () => {
    const report = buildStatusReport({
      configDirOverride: tmpDir,
      licenseToken: "AXON-very-long-license-token-7890",
    });
    expect(report.tier).toBe("pro");
    expect(report.license_token_preview).toBe("…7890");
  });

  it("defaults endpoint to STATUS_DEFAULT_ENDPOINT when none supplied", () => {
    const report = buildStatusReport({ configDirOverride: tmpDir });
    expect(report.endpoint).toBe(STATUS_DEFAULT_ENDPOINT);
  });

  it("defaults upgrade URL to STATUS_DEFAULT_UPGRADE_URL when none supplied", () => {
    const report = buildStatusReport({ configDirOverride: tmpDir });
    expect(report.upgrade_url).toBe(STATUS_DEFAULT_UPGRADE_URL);
  });

  it("honours an explicit endpoint override", () => {
    const report = buildStatusReport({
      configDirOverride: tmpDir,
      endpoint: "https://my-axonflow.corp",
    });
    expect(report.endpoint).toBe("https://my-axonflow.corp");
  });

  it("reports tenant_id from the persisted registration file", () => {
    fs.writeFileSync(
      path.join(tmpDir, "try-registration.json"),
      JSON.stringify({
        tenant_id: "cs_real_tenant_xyz",
        secret: "s",
        expires_at: "2026-12-01T00:00:00Z",
        endpoint: STATUS_DEFAULT_ENDPOINT,
      }),
    );
    const report = buildStatusReport({ configDirOverride: tmpDir });
    expect(report.tenant_id).toBe("cs_real_tenant_xyz");
    expect(report.registration_present).toBe(true);
    expect(report.registration_file).toBe(path.join(tmpDir, "try-registration.json"));
  });

  it("reports tenant_id null + registration_present false when file is missing", () => {
    const report = buildStatusReport({ configDirOverride: tmpDir });
    expect(report.tenant_id).toBeNull();
    expect(report.registration_present).toBe(false);
  });

  it("uses sentinel registration path when configDir cannot be resolved", () => {
    const report = buildStatusReport({ configDirOverride: "" });
    expect(report.registration_file).toMatch(/AXONFLOW_CONFIG_DIR/);
    expect(report.tenant_id).toBeNull();
    expect(report.registration_present).toBe(false);
  });
});

describe("formatStatusReport", () => {
  it("renders free tier with upgrade URL", () => {
    const out = formatStatusReport({
      tenant_id: "cs_t1",
      endpoint: "https://try.getaxonflow.com",
      tier: "free",
      license_token_preview: null,
      upgrade_url: "https://getaxonflow.com/pro",
      registration_file: "/tmp/x/try-registration.json",
      registration_present: true,
    });
    expect(out).toContain("tenant_id:  cs_t1");
    expect(out).toContain("Stripe checkout custom field");
    expect(out).toContain("tier:       Free");
    expect(out).toContain("upgrade:    https://getaxonflow.com/pro");
    expect(out).not.toContain("license:");
  });

  it("renders Pro tier with the redacted preview only — never the full token", () => {
    const out = formatStatusReport({
      tenant_id: "cs_t2",
      endpoint: "https://try.getaxonflow.com",
      tier: "pro",
      license_token_preview: "…ABCD",
      upgrade_url: "https://getaxonflow.com/pro",
      registration_file: "/tmp/x/try-registration.json",
      registration_present: true,
    });
    expect(out).toContain("tier:       Pro");
    expect(out).toContain("license:    …ABCD");
    expect(out).toContain("redacted");
    // codex-plugin#41 regression guard: a representative full-token shape
    // must never appear in formatted output.
    expect(out).not.toMatch(/AXON-[A-Za-z0-9._-]{8,}/);
    // Free-tier upgrade hint must not appear when on Pro.
    expect(out).not.toContain("upgrade:");
  });

  it("renders an unregistered tenant_id with the recovery hint", () => {
    const out = formatStatusReport({
      tenant_id: null,
      endpoint: "https://try.getaxonflow.com",
      tier: "free",
      license_token_preview: null,
      upgrade_url: "https://getaxonflow.com/pro",
      registration_file: "/tmp/x/try-registration.json",
      registration_present: false,
    });
    expect(out).toContain("(not registered)");
    expect(out).toContain("axonflow-openclaw-recover");
    expect(out).toContain("/tmp/x/try-registration.json");
  });
});
