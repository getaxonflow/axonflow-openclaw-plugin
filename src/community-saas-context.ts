/**
 * Community-SaaS bootstrap context — environment + filesystem operations.
 *
 * Mirrors the split applied to the heartbeat path: env access and fs
 * reads/writes live here, away from the network-sending side
 * Handles opt-out checks, registration file persistence, rate-limit
 * backoff, and first-load disclosure stamps. The network-sending side
 * lives in community-saas-bootstrap.ts.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const DISCLOSURE_STAMP_NAME = "openclaw-plugin-community-saas-disclosure-shown";

/**
 * Test-harness inputs read from the process environment. Only honoured when
 * AXONFLOW_HARNESS=1 — production callers leave the var unset and the
 * defaults pin to try.getaxonflow.com.
 */
export interface HarnessInputs {
  harnessOn: boolean;
  harnessRegisterUrl: string;
  harnessAgentEndpoint: string;
}

export function resolveHarnessInputs(): HarnessInputs {
  const harnessOn = process.env["AXONFLOW_HARNESS"] === "1";
  const harnessRegisterUrl = harnessOn ? (process.env["AXONFLOW_HARNESS_REGISTER_URL"] ?? "") : "";
  const harnessAgentEndpoint = harnessOn ? (process.env["AXONFLOW_HARNESS_AGENT_ENDPOINT"] ?? "") : "";
  return { harnessOn, harnessRegisterUrl, harnessAgentEndpoint };
}

/**
 * Operator opt-out for Community-SaaS auto-bootstrap. Honours
 *   AXONFLOW_COMMUNITY_SAAS = "0" | "false" | "off" | "no"
 * (case-insensitive). Any other value (including unset) leaves the default
 * auto-bootstrap behaviour unchanged.
 *
 * This is the only programmatic way an operator can disable the implicit
 * try.getaxonflow.com registration without supplying a self-hosted
 * endpoint. Documented in README and surfaced in the first-load disclosure
 * banner so the consent surface is real.
 */
export function isCommunitySaasOptedOut(): boolean {
  const raw = process.env["AXONFLOW_COMMUNITY_SAAS"];
  if (typeof raw !== "string") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no";
}

/**
 * Ensure a directory exists with mode 0o700 (owner-only on POSIX). Returns
 * true on success or false on any failure so callers can degrade safely.
 */
export function ensureSecureDir(dir: string): boolean {
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    }
    return true;
  } catch {
    return false;
  }
}

export interface PersistedRegistration {
  tenant_id: string;
  secret: string;
  expires_at: string;
  endpoint?: string;
}

/**
 * Read a Community-SaaS registration file if it is fresh enough to use,
 * has well-formed contents, and (on POSIX) lives at mode 0o600. Returns
 * null when the file is missing, malformed, expired, or unsafe.
 *
 * `refreshWindowMs` lets the caller decide how aggressively to refresh —
 * passing the same window ensures cached + fresh paths agree on lifetime.
 */
export function readRegistrationIfFreshAndSafe(
  file: string,
  now: () => Date,
  refreshWindowMs: number,
): PersistedRegistration | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
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
  if (remaining < refreshWindowMs) {
    return null;
  }
  return parsed;
}

export function isWithinBackoff(backoffFile: string, now: () => Date): boolean {
  if (!backoffFile) return false;
  try {
    const raw = fs.readFileSync(backoffFile, "utf8").trim();
    const until = Number(raw);
    if (!Number.isFinite(until) || until <= 0) return false;
    return until > Math.floor(now().getTime() / 1000);
  } catch {
    return false;
  }
}

/**
 * Atomic file write (tmp + rename) with an explicit POSIX mode. Used for
 * the registration file (0o600) and the rate-limit backoff stamp (0o600).
 */
export function writeFileAtomicallyWithMode(file: string, content: string, mode: number): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `${path.basename(file)}.tmp.${process.pid}`);
  fs.writeFileSync(tmp, content, { mode });
  try { fs.chmodSync(tmp, mode); } catch { /* best effort */ }
  fs.renameSync(tmp, file);
}

export function unlinkIfExists(file: string): void {
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* fine — already gone */ }
}

/**
 * Build the registration label sent in the POST body. Pure stdlib — no env
 * reads, no fs reads — kept here so the bootstrap module stays free of any
 */
export function buildRegistrationLabel(pluginVersion: string | undefined): string {
  const version = pluginVersion ?? "unknown";
  const platform = `${os.type()}-${os.arch()}`;
  const label = `openclaw-plugin@${version} / ${platform}`;
  return label.length > 255 ? label.slice(0, 255) : label;
}

/**
 * First-load disclosure stamp helpers. The bootstrap path emits a one-time
 * warning to the plugin logger explaining that auto-Community-SaaS
 * registration is about to happen and how to opt out. The stamp keeps the
 * warning from re-firing on every plugin reload.
 *
 * Stamp file lives next to the registration file so it shares the same
 * config-dir lifecycle (rm of try-registration.json without a re-warn is
 * intentional; the user already knows we register).
 */
export function disclosureStampPath(configDir: string): string {
  if (!configDir) return "";
  return path.join(configDir, DISCLOSURE_STAMP_NAME);
}

export function hasShownDisclosure(stampFile: string): boolean {
  if (!stampFile) return false;
  try {
    fs.statSync(stampFile);
    return true;
  } catch {
    return false;
  }
}

export function markDisclosureShown(stampFile: string): void {
  if (!stampFile) return;
  try {
    writeFileAtomicallyWithMode(stampFile, new Date().toISOString(), 0o600);
  } catch {
    // Best effort. If we can't stamp, we'll re-warn on the next load.
    // That's louder than ideal but never silent or wrong.
  }
}
