/**
 * Plugin status surface — read-only introspection for users.
 *
 * Solves the W4 paid-Pro launch UX gap: a user installs the plugin, then
 * needs to know their `tenant_id` to paste into the Stripe Payment Link
 * custom field before they can buy Pro. There was no way to surface that
 * value from the user's installed plugin without poking at on-disk
 * `try-registration.json` themselves. This module reads that same file
 * and reports the values back in a stable text shape the user can copy.
 *
 * Also reports tier state (Free vs Pro) and a redacted preview of the
 * configured Pro license token, so a user mid-rollout can confirm
 * whether `AXONFLOW_LICENSE_TOKEN` is wired through to this process.
 *
 * Security note (codex-plugin#41): we redact the license token to its
 * last 4 chars and never print the full value. The `cmd_status` handler
 * in the Codex plugin printed the raw token in human-readable status
 * output, which made it trivially leakable via screen-share / copy-paste.
 * Same surface here, same defensive redaction.
 *
 * Pure data + stdlib only — no network, no fs writes, no env mutations.
 * Safe to call from any context (CLI, agent tool, library consumer).
 */

import * as fs from "fs";
import * as path from "path";
import { axonflowConfigDir } from "./cache-dir.js";

/** Filename used by Community-SaaS bootstrap and recovery to persist credentials. */
const REGISTRATION_FILE_NAME = "try-registration.json";

/** Default agent endpoint the plugin talks to when no override is set. */
export const STATUS_DEFAULT_ENDPOINT = "https://try.getaxonflow.com";

/** Default upgrade URL surfaced in status output for free-tier users. */
export const STATUS_DEFAULT_UPGRADE_URL = "https://getaxonflow.com/pro";

/** Tier the plugin is currently operating under. */
export type StatusTier = "free" | "pro";

/** Inputs the status reader resolves up-front (testable). */
export interface StatusInputs {
  /**
   * Plugin-claim license token, if configured. Resolution order matches
   * `resolveConfig` in src/config.ts:
   *   1. process.env.AXONFLOW_LICENSE_TOKEN
   *   2. pluginConfig.licenseToken
   *   3. unset → undefined → free tier
   *
   * Empty / whitespace-only strings are treated as unset.
   */
  licenseToken?: string;

  /** Endpoint the plugin would talk to. Defaults to STATUS_DEFAULT_ENDPOINT. */
  endpoint?: string;

  /** Override config dir for tests / non-default deployments. */
  configDirOverride?: string;

  /** Override upgrade URL (for the AXONFLOW_UPGRADE_URL env knob). */
  upgradeUrl?: string;
}

/** Resolved status report — stable shape for both human + JSON consumers. */
export interface StatusReport {
  /** Tenant identifier from try-registration.json, or null if missing. */
  tenant_id: string | null;
  /** Endpoint the plugin would talk to. */
  endpoint: string;
  /** Tier indicator — "pro" iff a non-empty license token is configured. */
  tier: StatusTier;
  /**
   * Redacted preview of the license token (e.g. `…AB12`), or null when
   * no token is configured. NEVER contains more than the trailing 4
   * chars of the original token. See codex-plugin#41 for the regression
   * this guards against.
   */
  license_token_preview: string | null;
  /** Where to buy / manage a Pro license. */
  upgrade_url: string;
  /** Absolute path the registration file was read from (or attempted). */
  registration_file: string;
  /** True when the registration file is present + parseable. */
  registration_present: boolean;
}

/**
 * Redact a license token to a fixed-shape preview suitable for printing
 * in status output. Returns null for empty / whitespace-only / undefined
 * inputs so callers can branch on tier presence.
 *
 * Output is always at most `…XXXX` (5 chars: ellipsis + last 4 chars of
 * the input). Tokens shorter than 4 chars print as `…<token>` so we
 * never print a token whose preview is longer than the token itself
 * (which would be misleading) but we also never print MORE chars than
 * the last 4. The full token is never reconstructible from the preview.
 */
export function redactLicenseToken(token: string | undefined | null): string | null {
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  // Take last 4 chars (or fewer if the token is shorter). Always prefix
  // with an ellipsis so the user can tell the value was truncated.
  const tailLen = Math.min(4, trimmed.length);
  const tail = trimmed.slice(trimmed.length - tailLen);
  return `…${tail}`;
}

/**
 * Read the persisted Community-SaaS registration file and extract the
 * tenant_id. Returns null when the file is missing, unreadable, or has
 * no usable tenant_id field. Never throws — status output should
 * degrade gracefully when state is partial.
 *
 * Mode/permission checks are intentionally NOT enforced here: status is
 * a read-only surface and we want to report a tenant_id even from a
 * file with surprising permissions, so the user can see "yes you have
 * a tenant, but the file is unsafe — re-register" rather than silently
 * showing "no tenant_id found".
 */
export function readPersistedTenantId(file: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const tenantId = parsed["tenant_id"];
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    return null;
  }
  return tenantId;
}

/**
 * Build a fully-resolved status report from `StatusInputs`. Pure
 * (modulo the single fs read for try-registration.json) and
 * deterministic given the same inputs + on-disk state.
 */
export function buildStatusReport(inputs: StatusInputs = {}): StatusReport {
  const endpoint = (inputs.endpoint ?? "").trim() || STATUS_DEFAULT_ENDPOINT;
  const upgradeUrl = (inputs.upgradeUrl ?? "").trim() || STATUS_DEFAULT_UPGRADE_URL;

  const configDir = inputs.configDirOverride ?? axonflowConfigDir();
  // axonflowConfigDir() can legitimately return "" on locked-down hosts.
  // Use a stable string so the report still tells the user where we
  // looked (or would have looked) — never show "" / undefined to users.
  const registrationFile = configDir
    ? path.join(configDir, REGISTRATION_FILE_NAME)
    : "(unresolved — set AXONFLOW_CONFIG_DIR)";
  const tenantId = configDir ? readPersistedTenantId(registrationFile) : null;

  const licensePreview = redactLicenseToken(inputs.licenseToken);
  const tier: StatusTier = licensePreview ? "pro" : "free";

  return {
    tenant_id: tenantId,
    endpoint,
    tier,
    license_token_preview: licensePreview,
    upgrade_url: upgradeUrl,
    registration_file: registrationFile,
    registration_present: tenantId !== null,
  };
}

/**
 * Resolve `StatusInputs` from process.env + an optional pluginConfig
 * blob (mirrors `resolveConfig` semantics for the licenseToken /
 * endpoint fields). Pulled out as its own function so tests can drive
 * the env-resolution branches without the fs read.
 *
 * Resolution order:
 *   - licenseToken: env AXONFLOW_LICENSE_TOKEN > pluginConfig.licenseToken > undefined
 *   - endpoint:     env AXONFLOW_ENDPOINT > pluginConfig.endpoint > STATUS_DEFAULT_ENDPOINT
 *   - upgradeUrl:   env AXONFLOW_UPGRADE_URL > STATUS_DEFAULT_UPGRADE_URL
 *
 * `configDirOverride` is honoured for tests; production callers leave
 * it undefined and rely on `axonflowConfigDir()` (which itself honours
 * AXONFLOW_CONFIG_DIR).
 */
export function resolveStatusInputs(
  pluginConfig?: Record<string, unknown>,
  configDirOverride?: string,
): StatusInputs {
  const cfg = pluginConfig ?? {};

  const envToken = typeof process.env["AXONFLOW_LICENSE_TOKEN"] === "string"
    ? process.env["AXONFLOW_LICENSE_TOKEN"]!.trim()
    : "";
  const cfgToken = typeof cfg["licenseToken"] === "string"
    ? (cfg["licenseToken"] as string).trim()
    : "";
  const licenseToken = envToken || cfgToken || undefined;

  const envEndpoint = typeof process.env["AXONFLOW_ENDPOINT"] === "string"
    ? process.env["AXONFLOW_ENDPOINT"]!.trim()
    : "";
  const cfgEndpoint = typeof cfg["endpoint"] === "string"
    ? (cfg["endpoint"] as string).trim()
    : "";
  const endpoint = envEndpoint || cfgEndpoint || undefined;

  const envUpgrade = typeof process.env["AXONFLOW_UPGRADE_URL"] === "string"
    ? process.env["AXONFLOW_UPGRADE_URL"]!.trim()
    : "";
  const upgradeUrl = envUpgrade || undefined;

  const inputs: StatusInputs = {};
  if (licenseToken !== undefined) inputs.licenseToken = licenseToken;
  if (endpoint !== undefined) inputs.endpoint = endpoint;
  if (upgradeUrl !== undefined) inputs.upgradeUrl = upgradeUrl;
  if (configDirOverride !== undefined) inputs.configDirOverride = configDirOverride;
  return inputs;
}

/**
 * Format a status report as the human-readable text the CLI prints to
 * stdout. Stable line shape so users can grep / pipe it.
 *
 * The report is intentionally chatty for first-time users: we explain
 * what tenant_id is for (Stripe checkout custom field), and where to
 * recover lost credentials. Power users who want a stable structured
 * surface should consume `buildStatusReport()` directly.
 */
export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = [];
  lines.push("AxonFlow OpenClaw plugin status");
  lines.push("");
  if (report.tenant_id) {
    lines.push(`  tenant_id:  ${report.tenant_id}`);
    lines.push("              (paste this into the Stripe checkout custom field when buying Pro)");
  } else {
    lines.push("  tenant_id:  (not registered)");
    lines.push(`              No registration file at ${report.registration_file}`);
    lines.push("              The plugin auto-registers with Community SaaS on first init.");
    lines.push("              Lost your registration? Run `axonflow-openclaw-recover <email>`");
  }
  lines.push(`  endpoint:   ${report.endpoint}`);
  if (report.tier === "pro") {
    lines.push("  tier:       Pro (license token configured)");
    lines.push(`  license:    ${report.license_token_preview} (redacted — last 4 chars only)`);
  } else {
    lines.push("  tier:       Free");
    lines.push(`  upgrade:    ${report.upgrade_url}`);
  }
  lines.push("");
  return lines.join("\n");
}
