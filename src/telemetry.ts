/**
 * Usage telemetry — 7-day heartbeat.
 *
 * Sends a POST to checkpoint.getaxonflow.com on plugin initialization,
 * at most once every 7 days per machine. Payload includes: plugin
 * version, OS/arch, Node version, deployment mode, org_id, a persistent
 * per-machine instance_id, and hook configuration summary. Does not
 * include message contents, tool arguments, or policy data.
 *
 * Opt out: set AXONFLOW_TELEMETRY=off (also accepts 0, false, no).
 *
 * Configuration lives in telemetry-config.ts; stamp file management
 * in telemetry-context.ts; org_id resolution in telemetry-org-id.ts.
 */

import { axonflowCacheDir } from "./cache-dir.js";
import { ORG_ID_LOCAL_DEV_SENTINEL, telemetryOrgID } from "./telemetry-org-id.js";
import { loadTelemetryConfig } from "./telemetry-config.js";
import {
  captureRuntimeInfo,
  ensureCacheDir,
  readStampMetadata,
  resolveProbeEndpoint,
  stampPath,
  writeStampAtomic,
} from "./telemetry-context.js";

const TELEMETRY_TIMEOUT_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface TelemetryPayload {
  /**
   * v1 telemetry-schema discriminator. Always `"plugin"` for this codebase
   * — see #2008 for the umbrella tracking the four-plugin rollout.
   */
  telemetry_type: string;
  sdk: string;
  sdk_version: string;
  platform_version: string | null;
  os: string;
  arch: string;
  runtime_version: string;
  /**
   * v1 schema deployment-mode allowlist: `self_hosted | community_saas |
   * unknown`. Detected from the configured endpoint host, with
   * `AXONFLOW_TRY=1` as an explicit Community-SaaS override.
   */
  deployment_mode: string;
  /**
   * v1 schema endpoint-type allowlist: `localhost | private_network |
   * remote | unknown`. Strictly classifies the network reachability of
   * the endpoint; the prior cross-coupling with `community-saas` lives
   * on `deployment_mode` in v1.
   */
  endpoint_type: string;
  features: string[];
  instance_id: string;
  /**
   * v9.1 deployment-organization identifier (#2277). Three sources, in
   * precedence order: the `ORG_ID` env var; the `tenant_id` from the
   * registration file at `axonflowConfigDir()/try-registration.json`
   * (the `cs_<uuid>` Community SaaS tenant identifier); the
   * `"local-dev-org"` sentinel. Always emitted.
   */
  org_id: string;
}

// telemetryOrgID() + ORG_ID_LOCAL_DEV_SENTINEL live in
// ./telemetry-org-id.ts (re-exported above).
export { ORG_ID_LOCAL_DEV_SENTINEL, telemetryOrgID };

/**
 * Classify the configured endpoint into the v1 deployment-mode allowlist
 * (`self_hosted | community_saas | unknown`). Community-SaaS detection
 * fires on either an `*.try.getaxonflow.com` host or `AXONFLOW_TRY=1`
 * (the explicit override path for tenants behind custom hostnames). An
 * empty or unparseable endpoint resolves to `unknown` rather than
 * defaulting to `self_hosted` — we do not want to pollute the
 * self-hosted bucket with config gaps.
 */
export function classifyDeploymentMode(endpoint: string, trySaasFlag: boolean): string {
  if (trySaasFlag) return "community_saas";
  if (!endpoint) return "unknown";
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (!host) return "unknown";
  if (host === "try.getaxonflow.com" || host.endsWith(".try.getaxonflow.com")) {
    return "community_saas";
  }
  return "self_hosted";
}

/**
 * Classify the configured endpoint into the v1 endpoint-type allowlist
 * (`localhost | private_network | remote | unknown`). Mirrors the Go SDK
 * `ClassifyEndpoint` shape (axonflow-sdk-go/telemetry.go) so analytics
 * dimensions stay consistent across language clients. Note the v1 schema
 * removes the legacy `community-saas` endpoint-type value — that lives
 * on `deployment_mode` in v1.
 */
export function classifyEndpointType(endpoint: string): string {
  if (!endpoint) return "unknown";
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (!host) return "unknown";
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost")
  ) {
    return "localhost";
  }
  for (const suffix of [".local", ".internal", ".lan", ".intranet"]) {
    if (host.endsWith(suffix)) return "private_network";
  }
  if (/^10\./.test(host)) return "private_network";
  if (/^192\.168\./.test(host)) return "private_network";
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return "private_network";
  return "remote";
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
 * Send a telemetry heartbeat. Concurrent calls are de-duplicated
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

  // 2. Resolve the stamp file location and ensure the cache dir is private.
  const cacheDir = ensureCacheDir(axonflowCacheDir());
  const stampFile = stampPath(cacheDir);

  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();

  // 3. mtime check, defensive against future-dated stamps.
  const stamp = readStampMetadata(stampFile);
  if (stamp.exists && stamp.mtimeMs > 0 && stamp.mtimeMs <= nowMs) {
    const age = nowMs - stamp.mtimeMs;
    if (age < HEARTBEAT_INTERVAL_MS) {
      return; // fresh — skip
    }
  }
  const priorInstanceId = stamp.priorInstanceId;

  const instanceId =
    priorInstanceId && /^[a-f0-9-]{8,64}$/i.test(priorInstanceId)
      ? priorInstanceId
      : generateInstanceId();

  // 4. Detect platform version (best-effort).
  const probeEndpoint = resolveProbeEndpoint(options.endpoint);
  let platformVersion: string | null = null;
  try {
    platformVersion = await detectPlatformVersion(probeEndpoint);
  } catch {
    platformVersion = null;
  }

  const runtime = captureRuntimeInfo();

  // v1 telemetry-schema classifiers. `deployment_mode` is derived from the
  // configured endpoint host plus the explicit `AXONFLOW_TRY=1` override;
  // the prior `production`/`development` distinction (split on `onError`)
  // is removed in v1 — it didn't survive the cross-client alignment with
  // SDK pings, where the same dimension means deployment topology only.
  const deploymentMode = classifyDeploymentMode(options.endpoint, config.trySaasFlag);
  const endpointType = classifyEndpointType(options.endpoint);

  const payload: TelemetryPayload = {
    telemetry_type: "plugin",
    sdk: "openclaw-plugin",
    sdk_version: options.pluginVersion,
    platform_version: platformVersion,
    os: runtime.os,
    arch: runtime.arch,
    runtime_version: runtime.runtimeVersion,
    deployment_mode: deploymentMode,
    endpoint_type: endpointType,
    features: [
      `hooks:${options.hookCount}`,
      `high_risk_tools:${options.highRiskToolCount}`,
      `on_error:${options.onError}`,
      `mode:${options.mode}`,
    ],
    instance_id: instanceId,
    org_id: telemetryOrgID(),
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

  // 6. Stamp-on-delivery. The atomic write lives in telemetry-context.ts.
  if (delivered) {
    writeStampAtomic(stampFile, instanceId);
  }
}

/**
 * Test-only: clear the in-flight gate between tests.
 */
export function _resetTelemetryInFlightForTests(): void {
  inFlight = null;
}
