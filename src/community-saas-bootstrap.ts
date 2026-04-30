/**
 * Community-SaaS first-run bootstrap (TypeScript).
 *
 * Mirrors the bash plugins' scripts/community-saas-bootstrap.sh contract:
 * registers the plugin against try.getaxonflow.com on first run when the
 * user has not provided explicit clientId/clientSecret, persists the
 * resulting credential to a 0600 file under the user's config dir, and
 * returns Basic-auth credentials the caller can hand to the AxonFlow client.
 *
 * Design rules:
 *   - Stamp-on-delivery: registration file is written ONLY after the
 *     POST returns 201 with a valid response body. A network failure
 *     leaves the previous (or absent) state untouched.
 *   - Atomic writes: temp + rename so a crash mid-write never produces
 *     a half-readable file.
 *   - In-flight gate: a per-process Promise-based lock so concurrent
 *     plugin loads don't both race to register.
 *   - File permissions: 0700 directory, 0600 file. The file holds the
 *     plain-text credential; world-readable would be a security bug.
 *   - 429 (registration rate-limit) → write a short backoff stamp and
 *     return null. Next call after backoff expires retries.
 *   - Cross-platform cache dir resolution (Linux/macOS/Windows).
 *   - Refuses to load a registration file with non-0600 permissions
 *     (defends against silent credential leak via accidental chmod).
 *   - Operator opt-out via AXONFLOW_COMMUNITY_SAAS=0 short-circuits the
 *     bootstrap entirely; callers see source="opted-out".
 *
 * Environment + filesystem operations live in community-saas-context.ts.
 * This module is the orchestration + network-only side of the bootstrap:
 * it imports plain values from the context module and only issues HTTP
 * requests + invokes the plugin logger.
 */

import * as path from "path";
import { axonflowCacheDir, axonflowConfigDir } from "./cache-dir.js";
import {
  buildRegistrationLabel,
  disclosureStampPath,
  ensureSecureDir,
  hasShownDisclosure,
  isCommunitySaasOptedOut,
  isWithinBackoff,
  markDisclosureShown,
  readRegistrationIfFreshAndSafe,
  resolveHarnessInputs,
  unlinkIfExists,
  writeFileAtomicallyWithMode,
  type PersistedRegistration,
} from "./community-saas-context.js";

const REGISTER_URL_DEFAULT = "https://try.getaxonflow.com/api/v1/register";
const ENDPOINT_DEFAULT = "https://try.getaxonflow.com";
const REGISTRATION_FILE_NAME = "try-registration.json";
const BACKOFF_FILE_NAME = "openclaw-plugin-register-backoff";
const BACKOFF_SECONDS = 3600;
// Refresh registrations whose expires_at is within 30 days so we never let
// a tenant lapse silently while users are actively using the plugin.
const REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface BootstrapResult {
  /** Resolved AxonFlow agent endpoint to use for subsequent requests. */
  endpoint: string;
  /** Tenant identity for the AxonFlow client (`cs_<uuid>` for Community SaaS). */
  clientId: string;
  /** Plain-text credential paired with clientId for Basic auth. */
  clientSecret: string;
  /**
   * Source for telemetry / logging:
   *   "fresh-registration"  — first-time POST to /api/v1/register succeeded.
   *   "cached-registration" — existing on-disk credential is fresh enough.
   *   "rate-limited"        — 429 from the registrar; backoff active.
   *   "failed"              — network or response error; no credential.
   *   "opted-out"           — operator set AXONFLOW_COMMUNITY_SAAS=0.
   */
  source:
    | "fresh-registration"
    | "cached-registration"
    | "rate-limited"
    | "failed"
    | "opted-out";
}

/**
 * Optional injection hook for the disclosure banner. The plugin entry
 * point passes its OpenClaw `PluginLogger.warn` here so the banner shows
 * up in plugin/gateway logs in the same style as other plugin warnings.
 * When omitted, falls back to `process.stderr.write` so test harnesses
 * and ad-hoc invocations still surface the disclosure.
 */
export type DisclosureLogger = (message: string) => void;

/**
 * Per-process in-flight gate. When two plugin loads happen concurrently
 * (rare but possible in test harnesses or hot-reload scenarios), the second
 * waits on the first's promise rather than firing a duplicate registration.
 */
let inFlight: Promise<BootstrapResult | null> | null = null;

export interface BootstrapOptions {
  registerUrl?: string;
  endpoint?: string;
  pluginVersion?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /**
   * Caller-provided logger for the first-load Community-SaaS disclosure.
   * Plugin entry passes `api.logger.warn`; tests pass a capture function.
   */
  disclosureLogger?: DisclosureLogger;
}

/**
 * Bootstrap a Community-SaaS registration. Returns null if bootstrap was
 * skipped (registration file unreadable due to permissions, network error,
 * 429 rate-limited, etc); the caller is responsible for surfacing a clear
 * "governance degraded" notice in that case.
 *
 * Safe to call concurrently — the second concurrent call awaits the first
 * rather than racing.
 */
export async function bootstrapCommunitySaas(
  opts?: BootstrapOptions,
): Promise<BootstrapResult | null> {
  if (inFlight) {
    return inFlight;
  }
  inFlight = bootstrapCommunitySaasInner(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function bootstrapCommunitySaasInner(
  opts?: BootstrapOptions,
): Promise<BootstrapResult | null> {
  // 0. Operator opt-out short-circuits everything. No env-var disclosure
  //    lookup, no fs touches, no network — return immediately.
  if (isCommunitySaasOptedOut()) {
    return { endpoint: opts?.endpoint ?? ENDPOINT_DEFAULT, clientId: "", clientSecret: "", source: "opted-out" };
  }

  // 1. Test-harness URL overrides — only honoured when AXONFLOW_HARNESS=1
  //    and exclusively used by tests/heartbeat-real-stack/. Production
  //    callers leave AXONFLOW_HARNESS unset and the URLs stay pinned to
  //    try.getaxonflow.com.
  const harness = resolveHarnessInputs();
  const registerUrl = opts?.registerUrl ?? (harness.harnessRegisterUrl || REGISTER_URL_DEFAULT);
  const endpoint = opts?.endpoint ?? (harness.harnessAgentEndpoint || ENDPOINT_DEFAULT);
  const fetchFn = opts?.fetchImpl ?? fetch;
  const now = opts?.now ?? (() => new Date());

  const configDir = axonflowConfigDir();
  if (!configDir) {
    return null;
  }
  const registrationFile = path.join(configDir, REGISTRATION_FILE_NAME);

  const cacheDir = axonflowCacheDir();
  const backoffFile = cacheDir
    ? path.join(cacheDir, BACKOFF_FILE_NAME)
    : "";

  if (!ensureSecureDir(configDir)) {
    return null;
  }

  // Fast path: existing registration is fresh enough.
  const cached = readRegistrationIfFreshAndSafe(registrationFile, now, REFRESH_WINDOW_MS);
  if (cached) {
    return {
      endpoint: cached.endpoint ?? endpoint,
      clientId: cached.tenant_id,
      clientSecret: cached.secret,
      source: "cached-registration",
    };
  }

  // Backoff path: 429 told us to slow down. Honour it.
  if (backoffFile && isWithinBackoff(backoffFile, now)) {
    return { endpoint, clientId: "", clientSecret: "", source: "rate-limited" };
  }

  // First-load disclosure: announce the auto-registration once per machine
  // before issuing the network call. The stamp is written after the
  // banner emits so we don't re-warn on subsequent loads, but never before
  // the banner emits so a crash mid-disclosure stays loud.
  emitFirstLoadDisclosureIfNeeded({
    configDir,
    endpoint,
    registerUrl,
    logger: opts?.disclosureLogger,
  });

  // Issue the registration.
  const label = buildRegistrationLabel(opts?.pluginVersion);
  let response: Response;
  try {
    const ctl = new AbortController();
    const timeoutHandle = setTimeout(() => ctl.abort(), 10_000);
    try {
      response = await fetchFn(registerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch {
    return { endpoint, clientId: "", clientSecret: "", source: "failed" };
  }

  if (response.status === 429) {
    if (backoffFile && cacheDir && ensureSecureDir(cacheDir)) {
      try {
        const backoffUntil = Math.floor(now().getTime() / 1000) + BACKOFF_SECONDS;
        writeFileAtomicallyWithMode(backoffFile, String(backoffUntil), 0o600);
      } catch {
        // Best effort; if we can't write the backoff stamp, the next call retries.
      }
    }
    return { endpoint, clientId: "", clientSecret: "", source: "rate-limited" };
  }

  if (response.status !== 201) {
    return { endpoint, clientId: "", clientSecret: "", source: "failed" };
  }

  let parsed: PersistedRegistration;
  try {
    const body = (await response.json()) as Partial<PersistedRegistration>;
    if (
      typeof body.tenant_id !== "string" || body.tenant_id.length === 0 ||
      typeof body.secret !== "string" || body.secret.length === 0 ||
      typeof body.expires_at !== "string"
    ) {
      return { endpoint, clientId: "", clientSecret: "", source: "failed" };
    }
    parsed = {
      tenant_id: body.tenant_id,
      secret: body.secret,
      expires_at: body.expires_at,
      endpoint: typeof body.endpoint === "string" ? body.endpoint : endpoint,
    };
  } catch {
    return { endpoint, clientId: "", clientSecret: "", source: "failed" };
  }

  // Stamp-on-delivery: only write after a fully-validated response.
  try {
    writeFileAtomicallyWithMode(registrationFile, JSON.stringify(parsed), 0o600);
    if (backoffFile) {
      unlinkIfExists(backoffFile);
    }
  } catch {
    // We received valid credentials but couldn't persist them. Return them
    // anyway so the current process can still authenticate; on next run we
    // re-register (cheap; rate-limited, but bounded).
  }

  return {
    endpoint: parsed.endpoint ?? endpoint,
    clientId: parsed.tenant_id,
    clientSecret: parsed.secret,
    source: "fresh-registration",
  };
}

interface DisclosureEmitInputs {
  configDir: string;
  endpoint: string;
  registerUrl: string;
  logger: DisclosureLogger | undefined;
}

function emitFirstLoadDisclosureIfNeeded(inputs: DisclosureEmitInputs): void {
  const stampFile = disclosureStampPath(inputs.configDir);
  if (hasShownDisclosure(stampFile)) {
    return;
  }
  const banner = buildDisclosureBanner(inputs.endpoint, inputs.registerUrl);
  const delivered = emitDisclosureBanner(banner, inputs.logger);
  if (delivered) {
    markDisclosureShown(stampFile);
  }
  // If neither logger nor stderr accepted the banner, leave the stamp
  // unwritten so the next load tries again. Better to re-warn once we have
  // a working output than to silently swallow the disclosure.
}

function buildDisclosureBanner(endpoint: string, registerUrl: string): string {
  const url = new URL(registerUrl);
  const host = url.host;
  return [
    "AxonFlow Governance — Community SaaS auto-registration",
    "",
    `  This plugin will register with ${host} (Community SaaS) and use it`,
    "  to evaluate tool inputs and message bodies for policy + audit.",
    "",
    "  What is sent off-host on each governed call:",
    "    - tool name + arguments before execution",
    "    - outbound message bodies before delivery",
    "  What is NOT sent: LLM provider keys, OpenClaw conversation history",
    "  outside governed tools, or any data outside the OpenClaw runtime.",
    "",
    "  To opt out: set AXONFLOW_COMMUNITY_SAAS=0 in your environment, or",
    "  point the plugin at your own AxonFlow instance:",
    "      pluginConfig.endpoint = \"https://your-axonflow.example.com\"",
    "",
    "  This message shows once per machine; remove the disclosure stamp",
    `  to re-display: rm "$AXONFLOW_CONFIG_DIR"/openclaw-plugin-community-saas-disclosure-shown`,
    `  Default endpoint: ${endpoint}`,
    "  Docs: https://docs.getaxonflow.com/docs/integration/openclaw/",
  ].join("\n");
}

function emitDisclosureBanner(banner: string, logger: DisclosureLogger | undefined): boolean {
  if (logger) {
    try {
      logger(banner);
      return true;
    } catch {
      // Fall through to stderr.
    }
  }
  try {
    process.stderr.write(banner + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Test-only: clear the in-flight gate so test cases can exercise concurrent
 * bootstrap calls without sharing state across tests.
 */
export function _resetBootstrapInFlightForTests(): void {
  inFlight = null;
}
