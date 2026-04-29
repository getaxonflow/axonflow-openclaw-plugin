/**
 * Anonymous usage telemetry — 7-day heartbeat (TypeScript).
 *
 * Sends an anonymous POST to checkpoint.getaxonflow.com on plugin
 * initialization, at most once every 7 days per machine.
 *
 * Design rules (per feedback_telemetry_heartbeat_design_rules.md):
 *   1. Stamp-on-delivery, not stamp-on-attempt. Stamp file mtime
 *      advances ONLY after the HTTP POST returns 2xx. A transient
 *      network failure does not silence telemetry for 7 days.
 *   2. In-flight gate via a per-process Promise. Concurrent plugin
 *      loads do not race to send duplicate pings.
 *   3. Opt-out check FIRST, before any rate-limit or filesystem ops.
 *      AXONFLOW_TELEMETRY=off is re-evaluated every call.
 *   4. mtime as the freshness source; stamp body holds instance_id.
 *   5. Atomic stamp write: tmp + rename.
 *   6. Persistent instance_id across heartbeats.
 *   7. Defensive against future-dated stamps (clock skew → treat absent).
 *   8. Cross-platform cache dir resolution (cache-dir.ts).
 *
 * Configuration resolution (opt-out flags and checkpoint URL) lives in
 * telemetry-config.ts so this module only handles the network-sending side.
 */

import * as fs from "fs";
import * as path from "path";
import { axonflowCacheDir } from "./cache-dir.js";
import { loadTelemetryConfig } from "./telemetry-config.js";

const TELEMETRY_TIMEOUT_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const STAMP_FILE_NAME = "openclaw-plugin-telemetry-sent";

export interface TelemetryPayload {
  sdk: string;
  sdk_version: string;
  platform_version: string | null;
  os: string;
  arch: string;
  runtime_version: string;
  deployment_mode: string;
  features: string[];
  instance_id: string;
}

let inFlight: Promise<void> | null = null;

function generateInstanceId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to fallback
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function detectPlatformVersion(endpoint: string): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const resp = await fetch(`${endpoint}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) return null;
    const body = (await resp.json()) as Record<string, unknown>;
    return typeof body.version === "string" && body.version ? body.version : null;
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

interface SendOptions {
  endpoint: string;
  pluginVersion: string;
  hookCount: number;
  highRiskToolCount: number;
  onError: string;
  /** "community-saas" | "self-hosted" — set by the caller after resolveConfig. */
  mode: string;
  now?: () => Date;
}

/**
 * Send an anonymous telemetry heartbeat. Concurrent calls are de-duplicated
 * via a per-process in-flight gate; the second concurrent caller awaits the
 * first's promise rather than firing a duplicate.
 *
 * Returns a promise that resolves when the heartbeat completes (success,
 * skip, or failure). Production callers should treat as fire-and-forget;
 * tests can await for assertions.
 */
export function sendTelemetryPing(options: SendOptions): Promise<void> {
  if (inFlight) {
    return inFlight;
  }
  inFlight = sendInner(options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function sendInner(options: SendOptions): Promise<void> {
  // 1. Opt-out check FIRST.
  const config = loadTelemetryConfig();
  if (config.optedOut) {
    return;
  }

  // 2. Resolve stamp file location.
  const cacheDir = axonflowCacheDir();
  let stampFile = "";
  if (cacheDir) {
    stampFile = path.join(cacheDir, STAMP_FILE_NAME);
    try {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") {
        try { fs.chmodSync(cacheDir, 0o700); } catch { /* best effort */ }
      }
    } catch {
      stampFile = ""; // continue without stamping
    }
  }

  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();

  // 3. mtime check, defensive against future-dated stamps.
  let priorInstanceId = "";
  if (stampFile) {
    try {
      const stat = fs.statSync(stampFile);
      const stampMtime = stat.mtimeMs;
      if (stampMtime > 0 && stampMtime <= nowMs) {
        const age = nowMs - stampMtime;
        if (age < HEARTBEAT_INTERVAL_MS) {
          return; // fresh — skip
        }
      }
      try {
        priorInstanceId = fs.readFileSync(stampFile, "utf8").trim();
      } catch {
        priorInstanceId = "";
      }
    } catch {
      // No stamp → fall through to send
    }
  }

  const instanceId =
    priorInstanceId && /^[a-f0-9-]{8,64}$/i.test(priorInstanceId)
      ? priorInstanceId
      : generateInstanceId();

  // 4. Detect platform version (best-effort).
  let platformVersion: string | null = null;
  try {
    platformVersion = await detectPlatformVersion(options.endpoint);
  } catch {
    platformVersion = null;
  }

  const proc = typeof process !== "undefined" ? process : null;

  // Community-SaaS users are first-class for analytics; classifying them as
  // "production" (because plugin-generated auth is present) hides them inside
  // the self-hosted bucket. Surface them explicitly here.
  const deploymentMode =
    options.mode === "community-saas"
      ? "community-saas"
      : options.onError === "block"
      ? "production"
      : "development";

  const payload: TelemetryPayload = {
    sdk: "openclaw-plugin",
    sdk_version: options.pluginVersion,
    platform_version: platformVersion,
    os: proc ? proc.platform : "unknown",
    arch: proc ? proc.arch : "unknown",
    runtime_version: proc ? proc.version.replace(/^v/, "") : "unknown",
    deployment_mode: deploymentMode,
    features: [
      `hooks:${options.hookCount}`,
      `high_risk_tools:${options.highRiskToolCount}`,
      `on_error:${options.onError}`,
      `mode:${options.mode}`,
    ],
    instance_id: instanceId,
  };

  // 5. Fire the heartbeat.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  let delivered = false;
  try {
    const resp = await fetch(config.checkpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    delivered = resp.ok;
  } catch {
    delivered = false;
  } finally {
    clearTimeout(timeoutId);
  }

  // 6. Stamp-on-delivery.
  if (delivered && stampFile) {
    try {
      const tmp = `${stampFile}.tmp.${process.pid ?? "x"}`;
      fs.writeFileSync(tmp, instanceId, { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
      fs.renameSync(tmp, stampFile);
    } catch {
      // We delivered but couldn't stamp. Next plugin init retries.
    }
  }
}

/**
 * Test-only: clear the in-flight gate between tests.
 */
export function _resetTelemetryInFlightForTests(): void {
  inFlight = null;
}
