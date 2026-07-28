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
 *   - buildStatusReport: free vs Pro vs Pro-expired tier, registered vs
 *     unregistered, endpoint default, upgrade URL default,
 *     registration_present flag, expires_at + expires_in_days population.
 *   - formatStatusReport: includes tenant_id when present, includes
 *     recovery hint when missing, NEVER prints the full license token,
 *     prints redacted preview only, surfaces expiry date in tier line.
 *   - parseLicenseTokenExpiry: well-formed JWT, malformed JWT, missing
 *     exp claim, non-numeric exp, AXON-prefixed and non-prefixed tokens.
 *   - daysUntil: future, past, zero, non-finite inputs.
 *   - formatExpiryDate: well-formed epoch, null input.
 *   - buildProTierInitLogLine: Pro active, Pro expired, unparseable token
 *     (legacy fallback), free tier (returns null).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildProTierInitLogLine,
  buildStatusReport,
  daysUntil,
  formatExpiryDate,
  formatStatusReport,
  parseLicenseTokenExpiry,
  readPersistedTenantId,
  redactLicenseToken,
  resolveStatusInputs,
  STATUS_DEFAULT_ENDPOINT,
  STATUS_DEFAULT_UPGRADE_URL,
} from "../src/status.js";

/**
 * Mint a structurally-valid AXON- token whose JWT payload contains a
 * given exp (unix epoch seconds). Signature is a placeholder — status
 * code only parses, never validates.
 */
function mintAxonJwt(expEpoch: number): string {
  const hdr = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "test", exp: expEpoch })).toString("base64url");
  const sig = "placeholder-signature-padding-padding-padding-padding-padding-pa";
  return `AXON-${hdr}.${payload}.${sig}`;
}

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

  it("resolves token/upgradeUrl to undefined and endpoint to the shared default when env + pluginConfig are empty", () => {
    const inputs = resolveStatusInputs();
    expect(inputs.licenseToken).toBeUndefined();
    // Since #162 the endpoint comes from the shared resolveEffectiveEndpoint
    // decision used by the governance runtime — with no user input either
    // channel, that is the Community-SaaS default (same value the runtime
    // would govern against), not "unset".
    expect(inputs.endpoint).toBe("https://try.getaxonflow.com");
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
    expect(report.expires_at).toBeNull();
    expect(report.expires_in_days).toBeNull();
  });

  it("reports Pro tier with redacted preview when license token is set (unparseable)", () => {
    // A non-JWT-shaped token still flips tier to "pro" (token presence is
    // sufficient — platform is the source of truth on validity); the
    // expires_at fields stay null because exp couldn't be extracted.
    const report = buildStatusReport({
      configDirOverride: tmpDir,
      licenseToken: "AXON-very-long-license-token-7890",
    });
    expect(report.tier).toBe("pro");
    expect(report.license_token_preview).toBe("…7890");
    expect(report.expires_at).toBeNull();
    expect(report.expires_in_days).toBeNull();
  });

  it("reports Pro tier with expiry date + days remaining for a future exp", () => {
    const now = 1_700_000_000;            // fixed epoch for determinism
    const exp = now + 30 * 86400;         // 30 days in the future
    const report = buildStatusReport({
      configDirOverride: tmpDir,
      licenseToken: mintAxonJwt(exp),
      nowEpochSeconds: now,
    });
    expect(report.tier).toBe("pro");
    expect(report.expires_at).toBe(formatExpiryDate(exp));
    expect(report.expires_in_days).toBe(30);
  });

  it("reports Pro-expired tier for a past exp + negative days_remaining", () => {
    const now = 1_700_000_000;
    const exp = now - 7 * 86400;          // 7 days in the past
    const report = buildStatusReport({
      configDirOverride: tmpDir,
      licenseToken: mintAxonJwt(exp),
      nowEpochSeconds: now,
    });
    expect(report.tier).toBe("pro_expired");
    expect(report.expires_at).toBe(formatExpiryDate(exp));
    expect(report.expires_in_days).toBe(-7);
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

  it("reports client_id (and legacy tenant_id alias) from the persisted registration file", () => {
    // The on-disk JSON file still uses the legacy `tenant_id` key for
    // file-format compat with v1.4.x and earlier installs — this fixture
    // models that compat invariant explicitly.
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
    expect(report.client_id).toBe("cs_real_tenant_xyz");
    // Legacy alias preserved so v1.4.x JSON consumers don't break.
    expect(report.tenant_id).toBe("cs_real_tenant_xyz");
    expect(report.registration_present).toBe(true);
    expect(report.registration_file).toBe(path.join(tmpDir, "try-registration.json"));
  });

  it("reports client_id null + registration_present false when file is missing", () => {
    const report = buildStatusReport({ configDirOverride: tmpDir });
    expect(report.client_id).toBeNull();
    expect(report.tenant_id).toBeNull();
    expect(report.registration_present).toBe(false);
  });

  it("uses sentinel registration path when configDir cannot be resolved", () => {
    const report = buildStatusReport({ configDirOverride: "" });
    expect(report.registration_file).toMatch(/AXONFLOW_CONFIG_DIR/);
    expect(report.client_id).toBeNull();
    expect(report.tenant_id).toBeNull();
    expect(report.registration_present).toBe(false);
  });
});

describe("formatStatusReport", () => {
  it("renders free tier with client_id label + bridge note + upgrade URL", () => {
    const out = formatStatusReport({
      client_id: "cs_t1",
      tenant_id: "cs_t1",
      endpoint: "https://try.getaxonflow.com",
      tier: "free",
      license_token_preview: null,
      expires_at: null,
      expires_in_days: null,
      upgrade_url: "https://getaxonflow.com/pricing/",
      registration_file: "/tmp/x/try-registration.json",
      registration_present: true,
      mode: "community-saas",
      identity_source: "community-saas-registration",
      plugin_config_recorded_at: null,
    });
    // v1.5.0 terminology: new label is `client_id:`, bridge note connects
    // it to the legacy term so v1.4.x users aren't confused.
    expect(out).toContain("client_id:  cs_t1");
    expect(out).toContain("(formerly tenant_id)");
    // v1.5.0 invariant: status MUST NOT use `tenant_id:` as the primary
    // labeled field. Bridge parenthetical "(formerly tenant_id)" is OK.
    expect(out).not.toMatch(/^\s*tenant_id:\s+cs_/m);
    expect(out).toContain("Stripe checkout custom field");
    expect(out).toContain("tier:       Free (no Pro license configured)");
    expect(out).toContain("upgrade:    https://getaxonflow.com/pricing/");
    expect(out).not.toContain("license:");
  });

  it("renders Pro tier with expiry date + days remaining when exp is parseable", () => {
    const out = formatStatusReport({
      client_id: "cs_t2",
      tenant_id: "cs_t2",
      endpoint: "https://try.getaxonflow.com",
      tier: "pro",
      license_token_preview: "…ABCD",
      expires_at: "2026-08-03",
      expires_in_days: 90,
      upgrade_url: "https://getaxonflow.com/pricing/",
      registration_file: "/tmp/x/try-registration.json",
      registration_present: true,
      mode: "community-saas",
      identity_source: "community-saas-registration",
      plugin_config_recorded_at: null,
    });
    expect(out).toContain("tier:       Pro (expires 2026-08-03, 90 days remaining)");
    expect(out).toContain("license:    …ABCD");
    expect(out).toContain("redacted");
    // codex-plugin#41 regression guard: a representative full-token shape
    // must never appear in formatted output.
    expect(out).not.toMatch(/AXON-[A-Za-z0-9._-]{8,}/);
    // Free-tier upgrade hint must not appear when on Pro.
    expect(out).not.toContain("upgrade:");
  });

  it("renders Pro tier with 'could not parse token' fallback when exp is missing", () => {
    const out = formatStatusReport({
      client_id: "cs_t2",
      tenant_id: "cs_t2",
      endpoint: "https://try.getaxonflow.com",
      tier: "pro",
      license_token_preview: "…ABCD",
      expires_at: null,                // exp could not be parsed
      expires_in_days: null,
      upgrade_url: "https://getaxonflow.com/pricing/",
      registration_file: "/tmp/x/try-registration.json",
      registration_present: true,
      mode: "community-saas",
      identity_source: "community-saas-registration",
      plugin_config_recorded_at: null,
    });
    expect(out).toContain("tier:       Pro (expires UNKNOWN — could not parse token)");
    expect(out).toContain("license:    …ABCD");
    expect(out).not.toMatch(/AXON-[A-Za-z0-9._-]{8,}/);
  });

  it("renders Pro-expired tier with renew CTA embedded in the tier line", () => {
    const out = formatStatusReport({
      client_id: "cs_t3",
      tenant_id: "cs_t3",
      endpoint: "https://try.getaxonflow.com",
      tier: "pro_expired",
      license_token_preview: "…ZZZZ",
      expires_at: "2026-02-04",
      expires_in_days: -90,
      upgrade_url: "https://getaxonflow.com/pricing/",
      registration_file: "/tmp/x/try-registration.json",
      registration_present: true,
      mode: "community-saas",
      identity_source: "community-saas-registration",
      plugin_config_recorded_at: null,
    });
    expect(out).toContain("tier:       Free (Pro expired 2026-02-04 — visit https://getaxonflow.com/pricing/ to renew)");
    expect(out).toContain("license:    …ZZZZ");
    expect(out).toContain("will not forward an expired token");
    // The expired-token state must NOT print the standalone "upgrade:"
    // line (the renew URL is already in the tier line — duplicating it
    // creates noise and risks the user clicking the wrong one).
    expect(out).not.toContain("upgrade:");
    // Bearer-credential leak guard.
    expect(out).not.toMatch(/AXON-[A-Za-z0-9._-]{8,}/);
  });

  it("renders an unregistered client_id (with bridge note) and recovery hint", () => {
    const out = formatStatusReport({
      client_id: null,
      tenant_id: null,
      endpoint: "https://try.getaxonflow.com",
      tier: "free",
      license_token_preview: null,
      expires_at: null,
      expires_in_days: null,
      upgrade_url: "https://getaxonflow.com/pricing/",
      registration_file: "/tmp/x/try-registration.json",
      registration_present: false,
      mode: "community-saas",
      identity_source: "unregistered",
      plugin_config_recorded_at: null,
    });
    expect(out).toContain("(not registered)");
    expect(out).toContain("(formerly tenant_id)");
    expect(out).toContain("axonflow-openclaw-recover");
    expect(out).toContain("/tmp/x/try-registration.json");
  });
});

describe("parseLicenseTokenExpiry", () => {
  it("returns null for undefined / null / empty / whitespace", () => {
    expect(parseLicenseTokenExpiry(undefined)).toBeNull();
    expect(parseLicenseTokenExpiry(null)).toBeNull();
    expect(parseLicenseTokenExpiry("")).toBeNull();
    expect(parseLicenseTokenExpiry("    ")).toBeNull();
  });

  it("returns null for a token with fewer than 2 segments", () => {
    expect(parseLicenseTokenExpiry("AXON-justonesegment")).toBeNull();
  });

  it("returns null for a token whose payload segment is undecodable", () => {
    // base64url accepts a wide range of inputs but JSON.parse will fail
    // on raw garbage.
    expect(parseLicenseTokenExpiry("AXON-aGVhZGVy.bm90anNvbg.signature")).toBeNull();
  });

  it("returns null when the JWT payload has no exp claim", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url");
    expect(parseLicenseTokenExpiry(`AXON-hdr.${payload}.sig`)).toBeNull();
  });

  it("returns null when exp is a string instead of a number", () => {
    const payload = Buffer.from(JSON.stringify({ exp: "1700000000" })).toString("base64url");
    expect(parseLicenseTokenExpiry(`AXON-hdr.${payload}.sig`)).toBeNull();
  });

  it("returns null when exp is non-finite or non-integer", () => {
    const inf = Buffer.from('{"exp":1e500}').toString("base64url");      // Infinity
    expect(parseLicenseTokenExpiry(`AXON-hdr.${inf}.sig`)).toBeNull();
    const float = Buffer.from('{"exp":1.5}').toString("base64url");
    expect(parseLicenseTokenExpiry(`AXON-hdr.${float}.sig`)).toBeNull();
    const negative = Buffer.from('{"exp":-1}').toString("base64url");
    expect(parseLicenseTokenExpiry(`AXON-hdr.${negative}.sig`)).toBeNull();
  });

  it("extracts a valid exp from a well-formed JWT", () => {
    const exp = 1_800_000_000;
    expect(parseLicenseTokenExpiry(mintAxonJwt(exp))).toBe(exp);
  });

  it("works without the AXON- prefix (pure JWT)", () => {
    const exp = 1_800_000_001;
    const minted = mintAxonJwt(exp);
    const bareJwt = minted.startsWith("AXON-") ? minted.slice(5) : minted;
    expect(parseLicenseTokenExpiry(bareJwt)).toBe(exp);
  });
});

describe("formatExpiryDate", () => {
  it("formats a unix epoch as YYYY-MM-DD UTC", () => {
    // 2026-08-03T00:00:00Z = 1785715200
    expect(formatExpiryDate(1_785_715_200)).toBe("2026-08-03");
  });

  it("returns null for null input", () => {
    expect(formatExpiryDate(null)).toBeNull();
  });

  it("returns null for non-finite input", () => {
    expect(formatExpiryDate(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatExpiryDate(Number.NaN)).toBeNull();
  });
});

describe("daysUntil", () => {
  const now = 1_700_000_000;

  it("returns null when either input is non-finite", () => {
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil(now, Number.NaN)).toBeNull();
  });

  it("forward-rounds 23h59m future to 1 day", () => {
    expect(daysUntil(now + 86399, now)).toBe(1);
  });

  it("returns N for exactly N days in the future", () => {
    expect(daysUntil(now + 7 * 86400, now)).toBe(7);
  });

  it("returns -N for exactly N days in the past", () => {
    expect(daysUntil(now - 30 * 86400, now)).toBe(-30);
  });

  it("returns 0 when exp == now", () => {
    expect(daysUntil(now, now)).toBe(0);
  });
});

describe("buildProTierInitLogLine", () => {
  const now = 1_700_000_000;

  it("returns null for missing / empty / whitespace token", () => {
    expect(buildProTierInitLogLine(undefined)).toBeNull();
    expect(buildProTierInitLogLine(null)).toBeNull();
    expect(buildProTierInitLogLine("")).toBeNull();
    expect(buildProTierInitLogLine("   ")).toBeNull();
  });

  it("emits 'Pro tier — expires DATE' canary for a future exp", () => {
    const exp = now + 90 * 86400;
    const line = buildProTierInitLogLine(mintAxonJwt(exp), STATUS_DEFAULT_UPGRADE_URL, now);
    expect(line).toBe(
      `[AxonFlow] Pro tier — expires ${formatExpiryDate(exp)} (90 days remaining); X-License-Token forwarded on every governed request`,
    );
  });

  it("emits 'Free tier — Pro expired DATE; visit URL to renew' canary for a past exp", () => {
    const exp = now - 30 * 86400;
    const line = buildProTierInitLogLine(mintAxonJwt(exp), "https://corp.example/buy", now);
    expect(line).toBe(
      `[AxonFlow] Free tier — Pro expired ${formatExpiryDate(exp)}; visit https://corp.example/buy to renew`,
    );
  });

  it("falls back to legacy 'Pro tier active' canary for an unparseable token", () => {
    // Pre-existing assertion contract on the canary line — runtime-e2e
    // greps for "Pro tier active" with a synthesized non-JWT test token.
    const line = buildProTierInitLogLine("AXON-not-a-real-jwt", STATUS_DEFAULT_UPGRADE_URL, now);
    expect(line).toBe(
      "[AxonFlow] Pro tier active — license token configured, X-License-Token will be forwarded on every governed request",
    );
  });

  it("uses the supplied upgrade URL only on the expired-tier branch", () => {
    // For Pro-active the URL is irrelevant — assert it's not present.
    const exp = now + 1 * 86400;
    const proLine = buildProTierInitLogLine(mintAxonJwt(exp), "https://CTA-NOT-PRINTED.example", now);
    expect(proLine).not.toContain("CTA-NOT-PRINTED");
  });
});
