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
 * Also reports tier state (Free vs Pro vs Pro-expired) and a redacted
 * preview of the configured Pro license token, so a user mid-rollout
 * can confirm whether `AXONFLOW_LICENSE_TOKEN` is wired through to
 * this process AND when their license expires.
 *
 * V1 SaaS Plugin Pro tier-line surface parity (codex / cursor / claude /
 * openclaw): the `tier` line includes the JWT `exp` claim from the
 * configured license token in three shapes:
 *   - Pro (expires YYYY-MM-DD, N days remaining)             exp future
 *   - Free (Pro expired YYYY-MM-DD — visit <url> to renew)   exp past
 *   - Free (no Pro license configured)                       no token
 * Plus a fallback "Pro (expires UNKNOWN — could not parse token)" for
 * tokens whose JWT body does not parse. Signature is NEVER validated
 * here — display only; the platform is the source of truth on validity.
 *
 * Security note (codex-plugin#41): we redact the license token to its
 * last 4 chars and never print the full value. The `cmd_status` handler
 * in the Codex plugin printed the raw token in human-readable status
 * output, which made it trivially leakable via screen-share / copy-paste.
 * Same surface here, same defensive redaction.
 *
 * Read-only introspection — reads process.env and the registration file
 * but performs no network calls and no writes.
 */

import * as fs from "fs";
import * as path from "path";
import { axonflowConfigDir } from "./cache-dir.js";

/** Filename used by Community-SaaS bootstrap and recovery to persist credentials. */
const REGISTRATION_FILE_NAME = "try-registration.json";

/** Default agent endpoint the plugin talks to when no override is set. */
export const STATUS_DEFAULT_ENDPOINT = "https://try.getaxonflow.com";

/** Default upgrade URL surfaced in status output for free-tier users. */
export const STATUS_DEFAULT_UPGRADE_URL = "https://getaxonflow.com/pricing/";

/**
 * Tier the plugin is currently operating under.
 *
 * - "free" — no license token loaded. Plugin sends no X-License-Token.
 * - "pro" — token loaded AND its JWT `exp` is in the future (or could
 *   not be parsed; we fall back to Pro for display when parsing fails
 *   so a user with a corrupt-but-valid-looking token sees Pro and the
 *   platform is the source of truth on whether it actually validates).
 * - "pro_expired" — token loaded BUT its JWT `exp` is in the past.
 *   Functionally Free for governance purposes (the agent will reject
 *   an expired token's claims) but distinguished here so the status
 *   surface can show a renew CTA rather than a generic "buy Pro" CTA.
 */
export type StatusTier = "free" | "pro" | "pro_expired";

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

  /**
   * Override "now" (unix epoch seconds) for tests asserting the
   * exp-future / exp-past branches deterministically. Production
   * callers leave this undefined; we use Date.now() / 1000.
   */
  nowEpochSeconds?: number;
}

/** Resolved status report — stable shape for both human + JSON consumers. */
export interface StatusReport {
  /**
   * Client identifier from try-registration.json (the JSON key on disk
   * is still `tenant_id` for file-format compat with installed base —
   * see v1.5.0 CHANGELOG and axonflow-enterprise#2230). Null if the
   * registration file is missing.
   *
   * v9 canonical field name. JSON consumers reading from
   * `axonflow-openclaw-status --json` SHOULD prefer this key over the
   * legacy `tenant_id` alias going forward; the alias remains populated
   * for backwards compat.
   */
  client_id: string | null;
  /**
   * Legacy alias of {@link client_id} — same value, preserved for JSON
   * consumers that scripted around the v1.4.x output shape. Will be
   * removed in v3.0.0; use {@link client_id} for new consumers.
   */
  tenant_id: string | null;
  /** Endpoint the plugin would talk to. */
  endpoint: string;
  /** Tier indicator — see {@link StatusTier} for the semantics of each value. */
  tier: StatusTier;
  /**
   * Redacted preview of the license token (e.g. `…AB12`), or null when
   * no token is configured. NEVER contains more than the trailing 4
   * chars of the original token. See codex-plugin#41 for the regression
   * this guards against.
   */
  license_token_preview: string | null;
  /**
   * Pro license expiry date as `YYYY-MM-DD` (UTC). Set when a token is
   * loaded AND its JWT `exp` claim parsed cleanly. Null when:
   *   - no token loaded (tier="free"), OR
   *   - token loaded but JWT body did not parse (tier="pro" with the
   *     "could not parse" fallback line in formatStatusReport).
   * Independent of whether the date is in the future or past — readers
   * branch on `tier === "pro_expired"` for the past case.
   */
  expires_at: string | null;
  /**
   * Days remaining until `expires_at` (forward-rounded so 23h59m left
   * shows as "1 days remaining"). Null when `expires_at` is null.
   * Negative when `tier === "pro_expired"` — i.e. days SINCE expiry,
   * encoded as a negative number so consumers can sort / threshold.
   */
  expires_in_days: number | null;
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
 * Parse the JWT `exp` claim out of an `AXON-`-prefixed license token.
 * Returns the unix-epoch second value as an integer, or null on any
 * parse failure (missing prefix, malformed segments, undecodable
 * base64url, missing/non-numeric exp claim).
 *
 * Signature is NEVER validated here — we only extract `exp` for display.
 * The platform is the source of truth on whether the token is actually
 * valid (it re-validates the Ed25519 signature + DB row on every
 * governed request).
 *
 * `Buffer.from(..., "base64url")` is supported on Node 16+; the openclaw
 * plugin's package.json pins `>=18`, so this is safe.
 */
export function parseLicenseTokenExpiry(token: string | undefined | null): number | null {
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  // Strip the AXON- prefix; rest is JWT (header.payload.signature).
  const jwt = trimmed.startsWith("AXON-") ? trimmed.slice(5) : trimmed;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  const payloadSegment = parts[1];
  if (typeof payloadSegment !== "string" || payloadSegment.length === 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(payloadSegment, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (decoded.length === 0) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
  const exp = payload["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp) || !Number.isInteger(exp)) {
    return null;
  }
  // Unix epoch seconds are positive integers; reject obvious garbage.
  if (exp <= 0) return null;
  return exp;
}

/**
 * Format a unix epoch second value as `YYYY-MM-DD` in UTC. Returns null
 * on any toISOString failure (Date constructor rejects truly enormous
 * values). `Date` accepts ms so we multiply by 1000.
 */
export function formatExpiryDate(epochSeconds: number | null): string | null {
  if (epochSeconds === null || !Number.isFinite(epochSeconds)) return null;
  try {
    const iso = new Date(epochSeconds * 1000).toISOString();
    return iso.slice(0, 10);
  } catch {
    return null;
  }
}

/**
 * Compute days remaining until `epochSeconds`, given a "now". Forward-
 * rounded (23h59m left → 1 day). Negative when `epochSeconds < now` —
 * encoded as days SINCE expiry so consumers can sort / threshold.
 *
 * Returns null when either input is non-finite.
 */
export function daysUntil(epochSeconds: number | null, nowEpochSeconds: number): number | null {
  if (epochSeconds === null || !Number.isFinite(epochSeconds) || !Number.isFinite(nowEpochSeconds)) {
    return null;
  }
  const secondsDiff = epochSeconds - nowEpochSeconds;
  if (secondsDiff >= 0) {
    // Forward-round: 23h59m future → 1 day.
    return Math.ceil(secondsDiff / 86400);
  }
  // Past: forward-round magnitude, return as negative.
  return -Math.ceil((-secondsDiff) / 86400);
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

  // Compute tier + expiry. Three branches:
  //   1. No token → "free", expires_at null.
  //   2. Token + exp parsed:
  //      2a. exp future → "pro", expires_at = YYYY-MM-DD, days_left positive.
  //      2b. exp past   → "pro_expired", expires_at = YYYY-MM-DD, days_left negative.
  //   3. Token + exp NOT parsed → "pro", expires_at null (formatter
  //      surfaces "could not parse token").
  let tier: StatusTier = "free";
  let expiresAt: string | null = null;
  let expiresInDays: number | null = null;
  if (licensePreview !== null) {
    // A token was supplied (any non-whitespace string) — start from "pro"
    // and downgrade to "pro_expired" only if exp is parseable AND past.
    tier = "pro";
    const expEpoch = parseLicenseTokenExpiry(inputs.licenseToken);
    if (expEpoch !== null) {
      expiresAt = formatExpiryDate(expEpoch);
      const now = inputs.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
      expiresInDays = daysUntil(expEpoch, now);
      if (expEpoch <= now) {
        tier = "pro_expired";
      }
    }
  }

  return {
    client_id: tenantId,
    tenant_id: tenantId,
    endpoint,
    tier,
    license_token_preview: licensePreview,
    expires_at: expiresAt,
    expires_in_days: expiresInDays,
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
 * what client_id is for (Stripe checkout custom field, still labeled
 * "AxonFlow tenant ID" on the Stripe form until that surface rebrands
 * separately), and where to recover lost credentials. Power users who
 * want a stable structured surface should consume `buildStatusReport()`
 * directly — both `client_id` and `tenant_id` keys are populated in
 * the report for v2.4.x → v2.5.0 JSON-consumer compat.
 */
export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = [];
  lines.push("AxonFlow OpenClaw plugin status");
  lines.push("");
  if (report.client_id) {
    lines.push(`  client_id:  ${report.client_id}  (formerly tenant_id)`);
    lines.push("              (paste this into the Stripe checkout custom field when buying Pro —");
    lines.push("              the form's field label is still 'AxonFlow tenant ID' for now)");
  } else {
    lines.push("  client_id:  (not registered)  (formerly tenant_id)");
    lines.push(`              No registration file at ${report.registration_file}`);
    lines.push("              The plugin auto-registers with Community SaaS on first init.");
    lines.push("              Lost your registration? Run `axonflow-openclaw-recover <email>`");
  }
  lines.push(`  endpoint:   ${report.endpoint}`);

  // V1 SaaS Plugin Pro tier-line surface parity (codex / cursor / claude /
  // openclaw): four shapes, see StatusTier doc + parseLicenseTokenExpiry.
  if (report.tier === "pro") {
    if (report.expires_at !== null && report.expires_in_days !== null) {
      lines.push(`  tier:       Pro (expires ${report.expires_at}, ${report.expires_in_days} days remaining)`);
    } else {
      // Token loaded but JWT body did not parse. Treat as Pro for
      // display; platform is the source of truth on validity.
      lines.push("  tier:       Pro (expires UNKNOWN — could not parse token)");
    }
    lines.push(`  license:    ${report.license_token_preview} (redacted — last 4 chars only)`);
  } else if (report.tier === "pro_expired") {
    // Token still on disk but its exp is past — surface the renew CTA in
    // the tier line itself so users notice it even if they only scan the
    // first column. Don't print a generic "upgrade:" line on top — that
    // would be redundant with the renew URL embedded in the tier line.
    const expiresLabel = report.expires_at ?? "UNKNOWN";
    lines.push(`  tier:       Free (Pro expired ${expiresLabel} — visit ${report.upgrade_url} to renew)`);
    lines.push(`  license:    ${report.license_token_preview} (redacted — last 4 chars only)`);
    lines.push("              The plugin will not forward an expired token.");
    lines.push("              After buying a renewal, set AXONFLOW_LICENSE_TOKEN=<new> or restart with");
    lines.push("              the new token in pluginConfig.licenseToken.");
  } else {
    lines.push("  tier:       Free (no Pro license configured)");
    lines.push(`  upgrade:    ${report.upgrade_url}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Build the one-line init log canary for the OpenClaw plugin's
 * `registerAxonFlowGovernance` registration path. Three shapes:
 *   - Pro active   → "[AxonFlow] Pro tier — expires YYYY-MM-DD (N days remaining); X-License-Token forwarded on every governed request"
 *   - Pro expired  → "[AxonFlow] Free tier — Pro expired YYYY-MM-DD; visit <url> to renew"
 *   - Pro (could not parse) → "[AxonFlow] Pro tier active — license token configured, X-License-Token will be forwarded on every governed request" (preserves the legacy line for unparseable tokens — a noisy regression of the canary on every malformed token would be worse than silent fallback).
 *
 * Returns `null` when `licenseToken` is empty / null — Free-tier installs
 * see no extra log line (matches the existing convention; only Pro state
 * gets a canary).
 */
export function buildProTierInitLogLine(
  licenseToken: string | undefined | null,
  upgradeUrl: string = STATUS_DEFAULT_UPGRADE_URL,
  nowEpochSeconds?: number,
): string | null {
  if (typeof licenseToken !== "string" || licenseToken.trim().length === 0) {
    return null;
  }
  const expEpoch = parseLicenseTokenExpiry(licenseToken);
  if (expEpoch === null) {
    // Legacy fallback — preserves byte-exact compat with the v2.1.x line
    // for unparseable tokens. Mode-clarity test (tests/mode-clarity.test.ts)
    // and any external grep on this string keep working.
    return "[AxonFlow] Pro tier active — license token configured, X-License-Token will be forwarded on every governed request";
  }
  const now = nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const expDate = formatExpiryDate(expEpoch);
  const daysLeft = daysUntil(expEpoch, now);
  if (expEpoch > now && expDate !== null && daysLeft !== null) {
    return `[AxonFlow] Pro tier — expires ${expDate} (${daysLeft} days remaining); X-License-Token forwarded on every governed request`;
  }
  // exp is past — surface the renew CTA on init even though the token is
  // still in config. Users notice this on the next plugin reload rather
  // than discovering it on a 401 from a governed call.
  const expLabel = expDate ?? "UNKNOWN";
  return `[AxonFlow] Free tier — Pro expired ${expLabel}; visit ${upgradeUrl} to renew`;
}
