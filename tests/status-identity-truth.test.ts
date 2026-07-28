/**
 * #167 — the status surfaces must report the endpoint and identity the
 * governance runtime actually uses.
 *
 * Two failures shipped in v2.8.4:
 *   - `axonflow-openclaw-status` is a standalone bin with no access to
 *     `pluginConfig`, so a self-hoster who configured
 *     `pluginConfig.endpoint` was told their traffic went to the Community
 *     SaaS, and was shown the cached `cs_` tenant they never authenticate as.
 *   - `axonflow_get_tenant_id` reported the same cached SaaS tenant.
 *
 * These tests pin the contract from both directions: the same
 * `resolveDeploymentTarget` decision drives runtime and display, and the
 * persisted plugin-config record can never outrank the reader's live
 * environment.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  resolveDeploymentTarget,
  resolveEffectiveEndpoint,
  resolveRegisteredEndpoint,
  COMMUNITY_SAAS_DEFAULT_ENDPOINT,
  SELF_HOSTED_DEFAULT_CLIENT_ID,
  SELF_HOSTED_DEFAULT_ENDPOINT,
} from "../src/endpoint-env.js";
import { resolveConfig } from "../src/config.js";
import {
  buildRecordedRuntimeInputs,
  readPluginRuntimeState,
  runtimeStatePath,
  writePluginRuntimeState,
  RUNTIME_STATE_FILE_NAME,
  RUNTIME_STATE_SCHEMA,
} from "../src/plugin-runtime-state.js";
import { buildStatusReport, formatStatusReport, resolveStatusInputs } from "../src/status.js";
import { buildGetTenantIdTool } from "../src/agent-tools.js";

const SELF_HOSTED_URL = "https://axonflow.acme.internal";
const OTHER_URL = "https://axonflow.other.internal";

let tmpDir: string;
const savedEndpoint = process.env["AXONFLOW_ENDPOINT"];
const savedConfigDir = process.env["AXONFLOW_CONFIG_DIR"];

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axonflow-167-"));
  delete process.env["AXONFLOW_ENDPOINT"];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  restoreEnv("AXONFLOW_ENDPOINT", savedEndpoint);
  restoreEnv("AXONFLOW_CONFIG_DIR", savedConfigDir);
});

// ───────────────────────────────────────────────────────────────────────
// One resolver: runtime and display cannot disagree
// ───────────────────────────────────────────────────────────────────────

describe("resolveDeploymentTarget — the single shared decision", () => {
  it("resolves env > pluginConfig > credentials-implied > community default", () => {
    process.env["AXONFLOW_ENDPOINT"] = SELF_HOSTED_URL;
    expect(resolveDeploymentTarget({ endpoint: OTHER_URL }).endpoint).toBe(SELF_HOSTED_URL);

    delete process.env["AXONFLOW_ENDPOINT"];
    expect(resolveDeploymentTarget({ endpoint: OTHER_URL }).endpoint).toBe(OTHER_URL);
    expect(resolveDeploymentTarget({ clientId: "acme" }).endpoint).toBe(
      SELF_HOSTED_DEFAULT_ENDPOINT,
    );
    expect(resolveDeploymentTarget({}).endpoint).toBe(COMMUNITY_SAAS_DEFAULT_ENDPOINT);
  });

  it("treats whitespace-only values as unset in both channels", () => {
    process.env["AXONFLOW_ENDPOINT"] = "   ";
    expect(resolveDeploymentTarget({ endpoint: OTHER_URL }).endpoint).toBe(OTHER_URL);
    expect(resolveDeploymentTarget({ endpoint: "  " })).toEqual({
      endpoint: COMMUNITY_SAAS_DEFAULT_ENDPOINT,
      mode: "community-saas",
      clientId: "",
      clientIdSource: "community-saas-bootstrap",
    });
  });

  it("derives mode + clientId alongside the endpoint", () => {
    expect(resolveDeploymentTarget({ endpoint: SELF_HOSTED_URL })).toEqual({
      endpoint: SELF_HOSTED_URL,
      mode: "self-hosted",
      clientId: SELF_HOSTED_DEFAULT_CLIENT_ID,
      clientIdSource: "self-hosted-default",
    });
    expect(resolveDeploymentTarget({ endpoint: SELF_HOSTED_URL, clientId: "acme-prod" })).toEqual({
      endpoint: SELF_HOSTED_URL,
      mode: "self-hosted",
      clientId: "acme-prod",
      clientIdSource: "plugin-config",
    });
    expect(resolveDeploymentTarget(undefined)).toEqual({
      endpoint: COMMUNITY_SAAS_DEFAULT_ENDPOINT,
      mode: "community-saas",
      clientId: "",
      clientIdSource: "community-saas-bootstrap",
    });
  });

  it("never throws on hostile / partial config", () => {
    for (const cfg of [
      { endpoint: 42 },
      { clientId: null },
      { clientSecret: {} },
      { endpoint: [], clientId: undefined },
    ] as unknown as Record<string, unknown>[]) {
      expect(() => resolveDeploymentTarget(cfg)).not.toThrow();
    }
  });

  it("resolveEffectiveEndpoint delegates rather than re-deriving", () => {
    const cases: Record<string, unknown>[] = [
      {},
      { endpoint: SELF_HOSTED_URL },
      { clientId: "acme" },
      { clientSecret: "s", clientId: "acme" },
    ];
    for (const cfg of cases) {
      expect(resolveEffectiveEndpoint(cfg)).toBe(resolveDeploymentTarget(cfg).endpoint);
    }
  });
});

describe("runtime and display agree by construction", () => {
  const CASES: Array<{ label: string; env?: string; cfg: Record<string, unknown> }> = [
    { label: "nothing configured", cfg: {} },
    { label: "pluginConfig endpoint", cfg: { endpoint: SELF_HOSTED_URL } },
    { label: "pluginConfig endpoint + clientId", cfg: { endpoint: SELF_HOSTED_URL, clientId: "acme-prod" } },
    { label: "credentials only", cfg: { clientId: "acme-prod", clientSecret: "s3cret" } },
    { label: "env endpoint beats pluginConfig", env: SELF_HOSTED_URL, cfg: { endpoint: OTHER_URL } },
    { label: "env endpoint alone", env: SELF_HOSTED_URL, cfg: {} },
  ];

  for (const c of CASES) {
    it(`reports the same endpoint + mode the runtime uses — ${c.label}`, () => {
      if (c.env !== undefined) process.env["AXONFLOW_ENDPOINT"] = c.env;
      const runtime = resolveConfig(c.cfg);
      const report = buildStatusReport({
        ...resolveStatusInputs(c.cfg, tmpDir),
        configDirOverride: tmpDir,
      });
      expect(report.endpoint).toBe(runtime.endpoint);
      expect(report.mode).toBe(runtime.mode);
      if (runtime.mode === "self-hosted") {
        // community-saas leaves clientId for the bootstrap to fill in; the
        // status surface reads it from the registration file instead.
        expect(report.client_id).toBe(runtime.clientId);
      }
    });
  }
});

// ───────────────────────────────────────────────────────────────────────
// The standalone CLI path: persisted inputs, live environment
// ───────────────────────────────────────────────────────────────────────

describe("resolveStatusInputs — standalone CLI (no pluginConfig in scope)", () => {
  it("reports the self-hosted endpoint recorded by the runtime instead of the SaaS default", () => {
    // The exact #167 repro: pluginConfig.endpoint set, no env var, CLI has
    // no pluginConfig context. v2.8.4 answered https://try.getaxonflow.com.
    writePluginRuntimeState(tmpDir, { endpoint: SELF_HOSTED_URL, clientId: "acme-prod" }, "test");

    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));

    expect(report.endpoint).toBe(SELF_HOSTED_URL);
    expect(report.mode).toBe("self-hosted");
    expect(report.client_id).toBe("acme-prod");
    expect(report.identity_source).toBe("plugin-config");
  });

  it("reports the self-hosted default identity when no clientId was configured", () => {
    writePluginRuntimeState(tmpDir, { endpoint: SELF_HOSTED_URL }, "test");
    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));
    expect(report.client_id).toBe(SELF_HOSTED_DEFAULT_CLIENT_ID);
    expect(report.identity_source).toBe("self-hosted-default");
  });

  it("distinguishes an explicitly-configured clientId of 'community' from the default", () => {
    writePluginRuntimeState(tmpDir, { endpoint: SELF_HOSTED_URL, clientId: "community" }, "test");
    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));
    expect(report.client_id).toBe("community");
    expect(report.identity_source).toBe("plugin-config");
  });

  it("does not present a cached Community-SaaS tenant to a self-hosted install", () => {
    fs.writeFileSync(
      path.join(tmpDir, "try-registration.json"),
      JSON.stringify({
        tenant_id: "cs_90b4e5d3-cached-saas",
        secret: "s",
        expires_at: "2030-01-01T00:00:00Z",
        endpoint: COMMUNITY_SAAS_DEFAULT_ENDPOINT,
      }),
    );
    writePluginRuntimeState(tmpDir, { endpoint: SELF_HOSTED_URL }, "test");

    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));

    expect(report.client_id).not.toBe("cs_90b4e5d3-cached-saas");
    expect(report.endpoint).toBe(SELF_HOSTED_URL);
    // The file is still on disk and still reported as present — we just
    // stop claiming its tenant is the identity in use.
    expect(report.registration_present).toBe(true);
  });

  it("falls back to the environment alone when no record exists", () => {
    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));
    expect(report.endpoint).toBe(COMMUNITY_SAAS_DEFAULT_ENDPOINT);
    expect(report.mode).toBe("community-saas");
    expect(report.config_recorded_at).toBeNull();
  });

  it("keeps the Community-SaaS registration as the identity in community-saas mode", () => {
    fs.writeFileSync(
      path.join(tmpDir, "try-registration.json"),
      JSON.stringify({ tenant_id: "cs_real", secret: "s", expires_at: "2030-01-01T00:00:00Z" }),
    );
    writePluginRuntimeState(tmpDir, {}, "test");
    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));
    expect(report.mode).toBe("community-saas");
    expect(report.client_id).toBe("cs_real");
    expect(report.tenant_id).toBe("cs_real");
    expect(report.identity_source).toBe("community-saas-registration");
  });

  it("does NOT adopt an endpoint from the registration file", () => {
    // Withdrawn deliberately: this surface reads that file without the
    // permission and freshness checks the runtime applies, and cannot see an
    // AXONFLOW_COMMUNITY_SAAS=0 opt-out in the runtime's environment, so
    // adopting its endpoint could report one the runtime would have refused.
    fs.writeFileSync(
      path.join(tmpDir, "try-registration.json"),
      JSON.stringify({
        tenant_id: "cs_real",
        secret: "s",
        expires_at: "2030-01-01T00:00:00Z",
        endpoint: "https://eu.try.getaxonflow.com",
      }),
    );
    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));
    expect(report.endpoint).toBe(COMMUNITY_SAAS_DEFAULT_ENDPOINT);
    expect(report.client_id).toBe("cs_real");
  });

  it("surfaces when the configuration values came from a previous plugin load", () => {
    writePluginRuntimeState(
      tmpDir,
      { endpoint: SELF_HOSTED_URL },
      "test",
      () => new Date("2026-07-28T11:02:14.881Z"),
    );
    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));
    expect(report.config_recorded_at).toBe("2026-07-28T11:02:14.881Z");
    expect(report.config_recorded_source).toBe("plugin-config");
  });
});

// ───────────────────────────────────────────────────────────────────────
// The AXONFLOW_ENDPOINT channel — the half a pluginConfig-only record drops
//
// Round-1 hostile review of this change found that recording pluginConfig
// alone left the #167 wrong answer fully intact for operators who configure
// through the environment: the runtime resolves their endpoint, the CLI is
// run from a shell that does not export the variable (a different terminal,
// a launchd/systemd-started OpenClaw, CI), and the CLI reports the
// Community-SaaS default plus the cached cs_ tenant — now decorated with a
// provenance timestamp. These tests pin both halves of that fix.
// ───────────────────────────────────────────────────────────────────────

describe("endpoint configured through AXONFLOW_ENDPOINT", () => {
  /** Simulate a plugin load whose ENVIRONMENT carried the endpoint. */
  function loadWithEnvEndpoint(url: string, cfg: Record<string, unknown> = {}): void {
    process.env["AXONFLOW_ENDPOINT"] = url;
    writePluginRuntimeState(tmpDir, cfg, "test");
    delete process.env["AXONFLOW_ENDPOINT"];
  }

  it("reports the runtime's endpoint to a CLI whose own shell has no AXONFLOW_ENDPOINT", () => {
    fs.writeFileSync(
      path.join(tmpDir, "try-registration.json"),
      JSON.stringify({ tenant_id: "cs_cached", secret: "s", expires_at: "2030-01-01T00:00:00Z" }),
    );
    loadWithEnvEndpoint(SELF_HOSTED_URL);

    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));

    expect(report.endpoint).toBe(SELF_HOSTED_URL);
    expect(report.mode).toBe("self-hosted");
    expect(report.client_id).not.toBe("cs_cached");
    expect(report.config_recorded_source).toBe("env");
  });

  it("matches what the runtime resolved, for both channels", () => {
    for (const [label, viaEnv] of [["env", true], ["pluginConfig", false]] as const) {
      fs.rmSync(runtimeStatePath(tmpDir), { force: true });
      if (viaEnv) {
        process.env["AXONFLOW_ENDPOINT"] = SELF_HOSTED_URL;
      }
      const cfg = viaEnv ? {} : { endpoint: SELF_HOSTED_URL };
      const runtime = resolveConfig(cfg);
      writePluginRuntimeState(tmpDir, cfg, "test");
      delete process.env["AXONFLOW_ENDPOINT"];

      const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));
      expect(`${label}:${report.endpoint}`).toBe(`${label}:${runtime.endpoint}`);
      expect(`${label}:${report.mode}`).toBe(`${label}:${runtime.mode}`);
    }
  });

  it("still lets the CLI's own live AXONFLOW_ENDPOINT win over the recorded one", () => {
    loadWithEnvEndpoint(SELF_HOSTED_URL);
    process.env["AXONFLOW_ENDPOINT"] = OTHER_URL;

    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));

    expect(report.endpoint).toBe(OTHER_URL);
    // ...and says so, rather than silently picking one of the two.
    expect(report.runtime_endpoint_at_last_load).toBe(SELF_HOSTED_URL);
    expect(formatStatusReport(report)).toContain(SELF_HOSTED_URL);
    expect(formatStatusReport(report)).toContain("NOTE:");
  });

  it("adds no divergence note when the live env agrees with the recorded value", () => {
    loadWithEnvEndpoint(SELF_HOSTED_URL);
    process.env["AXONFLOW_ENDPOINT"] = SELF_HOSTED_URL;
    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));
    expect(report.runtime_endpoint_at_last_load).toBeNull();
    expect(formatStatusReport(report)).not.toContain("NOTE:");
  });
});

describe("provenance is claimed only when the record contributed", () => {
  it("does NOT stamp an environment-only answer with a recorded timestamp", () => {
    // A record exists but carries nothing — the runtime had no endpoint
    // override and no clientId. Advertising its timestamp would read as
    // "I consulted the running runtime", which is the false-confirmation
    // half of #162/#167.
    writePluginRuntimeState(tmpDir, {}, "test");
    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));
    expect(report.config_recorded_at).toBeNull();
    expect(report.config_recorded_source).toBeNull();
    expect(formatStatusReport(report)).not.toContain("as recorded by the plugin load");
  });

  it("does NOT claim the recorded endpoint contributed when the live env overrode it", () => {
    writePluginRuntimeState(tmpDir, { endpoint: SELF_HOSTED_URL }, "test");
    process.env["AXONFLOW_ENDPOINT"] = OTHER_URL;
    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));
    expect(report.config_recorded_source).toBeNull();
  });

  it("claims provenance when the recorded clientId contributed even under an env override", () => {
    writePluginRuntimeState(tmpDir, { endpoint: SELF_HOSTED_URL, clientId: "acme-prod" }, "test");
    process.env["AXONFLOW_ENDPOINT"] = OTHER_URL;
    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));
    expect(report.client_id).toBe("acme-prod");
    expect(report.config_recorded_at).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Staleness: a recorded value can never outrank the live environment
// ───────────────────────────────────────────────────────────────────────

describe("stale persisted state cannot survive a config change", () => {
  it("a stale persisted endpoint does not win over the current AXONFLOW_ENDPOINT", () => {
    writePluginRuntimeState(tmpDir, { endpoint: OTHER_URL, clientId: "old-tenant" }, "test");
    process.env["AXONFLOW_ENDPOINT"] = SELF_HOSTED_URL;

    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));

    expect(report.endpoint).toBe(SELF_HOSTED_URL);
    // The runtime resolving the same inputs agrees.
    expect(resolveConfig({ endpoint: OTHER_URL, clientId: "old-tenant" }).endpoint).toBe(
      SELF_HOSTED_URL,
    );
  });

  it("a stale persisted endpoint never wins over a live in-process pluginConfig", () => {
    writePluginRuntimeState(tmpDir, { endpoint: OTHER_URL }, "test");
    const report = buildStatusReport(
      resolveStatusInputs({ endpoint: SELF_HOSTED_URL }, tmpDir),
    );
    expect(report.endpoint).toBe(SELF_HOSTED_URL);
  });

  it("an empty live pluginConfig is honoured as empty, not as 'read the record'", () => {
    // `{}` means "the config really is empty"; only `undefined` means
    // "I cannot see the config". A caller that has the config must never be
    // silently overridden by a record from a previous configuration.
    writePluginRuntimeState(tmpDir, { endpoint: OTHER_URL }, "test");
    const report = buildStatusReport(resolveStatusInputs({}, tmpDir));
    expect(report.endpoint).toBe(COMMUNITY_SAAS_DEFAULT_ENDPOINT);
    expect(report.config_recorded_at).toBeNull();
  });

  it("a config change rewrites the record on the next plugin load", () => {
    writePluginRuntimeState(tmpDir, { endpoint: OTHER_URL, clientId: "old" }, "test");
    expect(buildStatusReport(resolveStatusInputs(undefined, tmpDir)).endpoint).toBe(OTHER_URL);

    writePluginRuntimeState(tmpDir, { endpoint: SELF_HOSTED_URL, clientId: "new" }, "test");
    const after = buildStatusReport(resolveStatusInputs(undefined, tmpDir));
    expect(after.endpoint).toBe(SELF_HOSTED_URL);
    expect(after.client_id).toBe("new");
  });

  it("a config change that REMOVES the endpoint is reflected too", () => {
    writePluginRuntimeState(tmpDir, { endpoint: SELF_HOSTED_URL }, "test");
    writePluginRuntimeState(tmpDir, {}, "test");
    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));
    expect(report.endpoint).toBe(COMMUNITY_SAAS_DEFAULT_ENDPOINT);
    expect(report.mode).toBe("community-saas");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Record hygiene
// ───────────────────────────────────────────────────────────────────────

describe("plugin runtime-state record", () => {
  it("writes 0600 under the config dir and holds no credentials", () => {
    writePluginRuntimeState(
      tmpDir,
      {
        endpoint: SELF_HOSTED_URL,
        clientId: "acme-prod",
        clientSecret: "super-secret-value",
        licenseToken: "AXON-secret-token",
        userToken: "user-secret-token",
      },
      "2.8.4",
    );
    const file = path.join(tmpDir, RUNTIME_STATE_FILE_NAME);
    const raw = fs.readFileSync(file, "utf8");

    expect(raw).not.toContain("super-secret-value");
    expect(raw).not.toContain("AXON-secret-token");
    expect(raw).not.toContain("user-secret-token");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      "client_id",
      "endpoint_override",
      "endpoint_source",
      "plugin_version",
      "recorded_at",
      "schema",
    ]);
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("trims values and tolerates non-string config entries", () => {
    expect(buildRecordedRuntimeInputs({ endpoint: "  x  ", clientId: 5 } as unknown as Record<string, unknown>))
      .toEqual({ endpointOverride: "x", endpointSource: "plugin-config", clientId: "" });
    expect(buildRecordedRuntimeInputs(undefined))
      .toEqual({ endpointOverride: "", endpointSource: "none", clientId: "" });
  });

  it("records which channel supplied the endpoint override", () => {
    expect(buildRecordedRuntimeInputs({ endpoint: SELF_HOSTED_URL }).endpointSource).toBe("plugin-config");
    process.env["AXONFLOW_ENDPOINT"] = OTHER_URL;
    const fromEnv = buildRecordedRuntimeInputs({ endpoint: SELF_HOSTED_URL });
    expect(fromEnv.endpointOverride).toBe(OTHER_URL);
    expect(fromEnv.endpointSource).toBe("env");
  });

  it("returns null for missing, malformed, and unknown-schema records", () => {
    const file = runtimeStatePath(tmpDir);
    expect(readPluginRuntimeState(file)).toBeNull();

    fs.writeFileSync(file, "{ not json");
    expect(readPluginRuntimeState(file)).toBeNull();

    fs.writeFileSync(file, JSON.stringify([1, 2, 3]));
    expect(readPluginRuntimeState(file)).toBeNull();

    fs.writeFileSync(
      file,
      JSON.stringify({ schema: RUNTIME_STATE_SCHEMA + 99, endpoint_override: OTHER_URL }),
    );
    expect(readPluginRuntimeState(file)).toBeNull();

    // A v1 record (pluginConfig-only shape) must be ignored, not
    // half-interpreted: v1 could not represent the env channel at all.
    fs.writeFileSync(
      file,
      JSON.stringify({ schema: 1, plugin_config: { endpoint: OTHER_URL, clientId: "old" } }),
    );
    expect(readPluginRuntimeState(file)).toBeNull();

    expect(readPluginRuntimeState("")).toBeNull();
  });

  it("degrades to environment-only resolution when the record is unreadable", () => {
    fs.writeFileSync(runtimeStatePath(tmpDir), "{ not json");
    const report = buildStatusReport(resolveStatusInputs(undefined, tmpDir));
    expect(report.endpoint).toBe(COMMUNITY_SAAS_DEFAULT_ENDPOINT);
  });

  it("tolerates a record whose fields are missing or wrong-typed", () => {
    fs.writeFileSync(
      runtimeStatePath(tmpDir),
      JSON.stringify({ schema: RUNTIME_STATE_SCHEMA, endpoint_override: 42, endpoint_source: "bogus" }),
    );
    const state = readPluginRuntimeState(runtimeStatePath(tmpDir));
    expect(state?.endpoint_override).toBe("");
    expect(state?.endpoint_source).toBe("none");
    expect(state?.client_id).toBe("");
    expect(buildStatusReport(resolveStatusInputs(undefined, tmpDir)).endpoint).toBe(
      COMMUNITY_SAAS_DEFAULT_ENDPOINT,
    );
  });

  it("reports failure rather than throwing when no config dir is resolvable", () => {
    expect(writePluginRuntimeState("", { endpoint: SELF_HOSTED_URL }, "test")).toBe(false);
    expect(runtimeStatePath("")).toBe("");
  });
});

describe("resolveRegisteredEndpoint", () => {
  it("prefers a registered endpoint and ignores blank / non-string values", () => {
    expect(resolveRegisteredEndpoint("https://eu.example", "fallback")).toBe("https://eu.example");
    expect(resolveRegisteredEndpoint("  https://eu.example  ", "fallback")).toBe("https://eu.example");
    expect(resolveRegisteredEndpoint("", "fallback")).toBe("fallback");
    expect(resolveRegisteredEndpoint("   ", "fallback")).toBe("fallback");
    expect(resolveRegisteredEndpoint(undefined, "fallback")).toBe("fallback");
    expect(resolveRegisteredEndpoint(42, "fallback")).toBe("fallback");
  });
});

// ───────────────────────────────────────────────────────────────────────
// axonflow_get_tenant_id — in-process, live config, never the record
// ───────────────────────────────────────────────────────────────────────

describe("axonflow_get_tenant_id", () => {
  it("reports the identity + endpoint the live runtime config resolves", async () => {
    // A record from a different (stale) configuration is on disk; the tool
    // must ignore it entirely because it runs inside the runtime.
    writePluginRuntimeState(tmpDir, { endpoint: OTHER_URL, clientId: "stale" }, "test");
    process.env["AXONFLOW_CONFIG_DIR"] = tmpDir;

    const tool = buildGetTenantIdTool({ endpoint: SELF_HOSTED_URL, clientId: "acme-prod" });
    const res = await tool.execute("call-1", {});
    const details = res.details as Record<string, unknown>;

    expect(res.isError).toBeUndefined();
    expect(details["endpoint"]).toBe(SELF_HOSTED_URL);
    expect(details["tenant_id"]).toBe("acme-prod");
    expect(details["mode"]).toBe("self-hosted");
    expect(details["identity_source"]).toBe("plugin-config");
  });

  it("still reports the Community-SaaS tenant for a Community-SaaS install", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "try-registration.json"),
      JSON.stringify({ tenant_id: "cs_real", secret: "s", expires_at: "2030-01-01T00:00:00Z" }),
    );
    process.env["AXONFLOW_CONFIG_DIR"] = tmpDir;

    const tool = buildGetTenantIdTool({});
    const details = (await tool.execute("call-2", {})).details as Record<string, unknown>;

    expect(details["tenant_id"]).toBe("cs_real");
    expect(details["mode"]).toBe("community-saas");
    expect(details["endpoint"]).toBe(COMMUNITY_SAAS_DEFAULT_ENDPOINT);
  });
});
