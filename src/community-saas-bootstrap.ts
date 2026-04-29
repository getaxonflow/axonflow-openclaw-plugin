/**
 * Community-SaaS first-run bootstrap (TypeScript).
 *
 * Mirrors the bash plugins' scripts/community-saas-bootstrap.sh contract:
 * registers the plugin against try.getaxonflow.com on first run when the
 * user has not provided explicit clientId/clientSecret, persists the
 * resulting credential to a 0600 file under the user's config dir, and
 * returns Basic-auth credentials the caller can hand to the AxonFlow client.
 *
 * Design rules (per feedback_telemetry_heartbeat_design_rules.md and
 * feedback_pg_advisory_lock_pin_connection.md):
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
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { axonflowCacheDir, axonflowConfigDir } from "./cache-dir.js";

const REGISTER_URL_DEFAULT = "https://try.getaxonflow.com/api/v1/register";
const ENDPOINT_DEFAULT = "https://try.getaxonflow.com";
const REGISTRATION_FILE_NAME = "try-registration.json";
const BACKOFF_FILE_NAME = "openclaw-plugin-register-backoff";
const BACKOFF_SECONDS = 3600;
// Refresh registrations whose expires_at is within 30 days so we never let
// a tenant lapse silently while users are actively using the plugin.
const REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface PersistedRegistration {
  tenant_id: string;
  secret: string;
  expires_at: string;
  endpoint?: string;
}

export interface BootstrapResult {
  /** Resolved AxonFlow agent endpoint to use for subsequent requests. */
  endpoint: string;
  /** Tenant identity for the AxonFlow client (`cs_<uuid>` for Community SaaS). */
  clientId: string;
  /** Plain-text credential paired with clientId for Basic auth. */
  clientSecret: string;
  /** Source for telemetry / logging (`community-saas-fresh`, `community-saas-cached`, etc). */
  source: "fresh-registration" | "cached-registration" | "rate-limited" | "failed";
}

/**
 * Per-process in-flight gate. When two plugin loads happen concurrently
 * (rare but possible in test harnesses or hot-reload scenarios), the second
 * waits on the first's promise rather than firing a duplicate registration.
 */
let inFlight: Promise<BootstrapResult | null> | null = null;

/**
 * Bootstrap a Community-SaaS registration. Returns null if bootstrap was
 * skipped (registration file unreadable due to permissions, network error,
 * 429 rate-limited, etc); the caller is responsible for surfacing a clear
 * "governance degraded" notice in that case.
 *
 * Safe to call concurrently — the second concurrent call awaits the first
 * rather than racing.
 */
export async function bootstrapCommunitySaas(opts?: {
  registerUrl?: string;
  endpoint?: string;
  pluginVersion?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<BootstrapResult | null> {
  if (inFlight) {
    return inFlight;
  }
  inFlight = bootstrapCommunitySaasInner(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function bootstrapCommunitySaasInner(opts?: {
  registerUrl?: string;
  endpoint?: string;
  pluginVersion?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<BootstrapResult | null> {
  const registerUrl = opts?.registerUrl ?? REGISTER_URL_DEFAULT;
  const endpoint = opts?.endpoint ?? ENDPOINT_DEFAULT;
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

  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }

  // Fast path: existing registration is fresh enough.
  const cached = readRegistrationIfFreshAndSafe(registrationFile, now);
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

  // Issue the registration.
  const label = buildLabel(opts?.pluginVersion);
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
    if (backoffFile && cacheDir) {
      try {
        fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
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
      try { fs.unlinkSync(backoffFile); } catch { /* fine */ }
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

function readRegistrationIfFreshAndSafe(
  file: string,
  now: () => Date,
): PersistedRegistration | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  // Refuse to read a registration file with non-0600 permissions. World-
  // readable credential storage is a real bug; the caller surfaces the
  // refusal so the user knows to delete + re-register.
  if (process.platform !== "win32") {
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      try {
        process.stderr.write(
          `[AxonFlow] ${file} has unsafe permissions (${mode.toString(8).padStart(3, "0")}); refusing to use. ` +
          `Re-register: rm ${JSON.stringify(file)} and reload.\n`,
        );
      } catch { /* stderr unavailable in some hosts */ }
      return null;
    }
  }
  let parsed: PersistedRegistration;
  try {
    const raw = fs.readFileSync(file, "utf8");
    parsed = JSON.parse(raw) as PersistedRegistration;
  } catch {
    return null;
  }
  if (
    typeof parsed.tenant_id !== "string" || parsed.tenant_id.length === 0 ||
    typeof parsed.secret !== "string" || parsed.secret.length === 0 ||
    typeof parsed.expires_at !== "string"
  ) {
    return null;
  }
  const expiresMs = Date.parse(parsed.expires_at);
  if (!Number.isFinite(expiresMs)) {
    return null;
  }
  const remaining = expiresMs - now().getTime();
  if (remaining < REFRESH_WINDOW_MS) {
    return null;
  }
  return parsed;
}

function isWithinBackoff(backoffFile: string, now: () => Date): boolean {
  try {
    const raw = fs.readFileSync(backoffFile, "utf8").trim();
    const until = Number(raw);
    if (!Number.isFinite(until) || until <= 0) return false;
    return until > Math.floor(now().getTime() / 1000);
  } catch {
    return false;
  }
}

function buildLabel(pluginVersion: string | undefined): string {
  const version = pluginVersion ?? "unknown";
  const platform = `${os.type()}-${os.arch()}`;
  const label = `openclaw-plugin@${version} / ${platform}`;
  return label.length > 255 ? label.slice(0, 255) : label;
}

function writeFileAtomicallyWithMode(file: string, content: string, mode: number): void {
  // tmp file in the same directory so rename is atomic on POSIX. On Windows,
  // fs.renameSync replaces the destination atomically since Node 14+.
  const dir = path.dirname(file);
  const tmp = path.join(dir, `${path.basename(file)}.tmp.${process.pid}`);
  fs.writeFileSync(tmp, content, { mode });
  // chmod again because some filesystems / umask combinations ignore the
  // mode passed to writeFileSync for already-existing temp files.
  try { fs.chmodSync(tmp, mode); } catch { /* best effort */ }
  fs.renameSync(tmp, file);
}

/**
 * Test-only: clear the in-flight gate so test cases can exercise concurrent
 * bootstrap calls without sharing state across tests.
 */
export function _resetBootstrapInFlightForTests(): void {
  inFlight = null;
}
