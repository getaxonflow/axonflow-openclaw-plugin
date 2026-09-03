/**
 * Usage telemetry — 7-day heartbeat.
 *
 * Sends a POST to checkpoint.getaxonflow.com on plugin initialization,
 * at most once every 7 days per machine. Payload includes: plugin
 * version, OS/arch, Node version, deployment mode, org_id, a persistent
 * per-machine instance_id, hook configuration summary, and the licence
 * tier the platform reports about itself (a coarse bucket such as
 * Community or Enterprise — no licence key, no expiry, no seat count, no
 * customer name). Does not include message contents, tool arguments, or
 * policy data.
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
  /**
   * The licence tier the PLATFORM reports about ITSELF (#3619), read from
   * the `tier` key of the `/health` response this heartbeat already fetches
   * for `platform_version`. Server-asserted: the plugin relays it and never
   * derives, corrects, or normalizes it.
   *
   * THREE DIMENSIONS THAT SOUND ALIKE AND ARE NOT. They disagree routinely
   * and none may be derived from another:
   *   - `license_tier` — what licence the platform says it runs under. A
   *     `self_hosted` endpoint is routinely Enterprise-licensed.
   *   - `deployment_mode` — where this plugin is POINTED, classified locally
   *     from the endpoint host. `community_saas` is a hosting topology, not
   *     the `Community` tier.
   *   - `endpoint_type` — that endpoint's network reachability.
   *
   * Values are the platform's, not a closed set this build owns: the
   * canonical tiers (`Community` / `Evaluation` / `Professional` /
   * `Enterprise` / `Plus`), the lowercase `community` a community-mode build
   * defaults to, and `starting` — the transient pre-initialisation answer,
   * which is a real reported state rather than an error. A tier issued after
   * this plugin shipped is relayed intact so the receiver, which owns the
   * canonical mapping, can bucket it correctly.
   *
   * OPTIONAL, and OMITTED rather than sent as `"unknown"` whenever the probe
   * could not establish it: unreachable endpoint, non-2xx, malformed or
   * non-object body, and a `tier` that is absent, blank, or not a string.
   * Omission is the wire's existing "this client did not report" signal (the
   * field is `omitempty` server-side); sending `"unknown"` would instead
   * assert that the platform answered and said it did not know.
   */
  license_tier?: string;

  /**
   * The platform's edition, as it reported it on `/health`. Absent means NOT
   * LEARNED - the probe did not answer, or answered without the member, which
   * is the case for every platform released before enterprise#3662.
   */
  edition?: string;

  /**
   * The deployment mode the PLATFORM reports about ITSELF. Deliberately
   * distinct from `deployment_mode` above, which is this plugin's own
   * classification of the endpoint it was pointed at: the two share a
   * vocabulary, answer different questions, and routinely disagree.
   */
  platform_deployment_mode?: string;
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

/**
 * Longest tier the platform can legitimately report is `EnterprisePlus` at 14
 * characters. Anything past 64 is not a tier — a hostile or broken endpoint
 * controls this string — so it is dropped whole rather than shipped or
 * truncated. Truncating would invent a tier the platform never reported.
 */
const MAX_RELAYED_VALUE_LENGTH = 64;

/**
 * What a single `/health` probe yielded. Both fields are independently
 * nullable: an older platform answers with a `version` and no `tier`, and
 * that must cost us the tier only.
 */
interface PlatformInfo {
  version: string | null;
  licenseTier: string | null;
  /** `/health` -> `edition`, added platform-side by axonflow-enterprise#3662. */
  edition: string | null;
  /**
   * `/health` -> `deployment_mode`: the PLATFORM'S OWN deployment mode.
   *
   * Relayed as `platform_deployment_mode` and never onto the payload's
   * `deployment_mode`, which is this plugin's local classification of the
   * endpoint it was pointed at. The two share a vocabulary and answer
   * different questions; writing one over the other would corrupt every
   * existing deployment-mode figure rather than merely losing a dimension.
   */
  platformDeploymentMode: string | null;
}

const NO_PLATFORM_INFO: PlatformInfo = {
  version: null,
  licenseTier: null,
  edition: null,
  platformDeploymentMode: null,
};

/**
 * Read ONE member out of a `/health` body and decide whether it was LEARNED.
 *
 * Every relayed dimension goes through this, so all of them obey the same rule
 * and a new one cannot arrive with weaker checks: present, a JSON string,
 * non-empty, and at most `MAX_RELAYED_VALUE_LENGTH` bytes. Anything else is
 * NOT LEARNED and the caller omits the field rather than asserting something
 * the platform did not say.
 *
 * The length cap is not tidiness. A hostile or broken endpoint controls these
 * strings and the checkpoint service rejects a request body over 64 KiB, so an
 * uncapped relay lets a `/health` response that SUCCEEDS destroy the ping it
 * was meant to enrich, taking every other dimension with it. Over-long values
 * are dropped WHOLE, never truncated: a truncated string is a value the
 * platform never reported.
 */
function relayedValue(body: Record<string, unknown>, key: string): string | null {
  const raw = body[key];
  if (typeof raw !== "string" || !raw) return null;
  // BYTES, not `raw.length`. `String.length` counts UTF-16 code units, so 64
  // "€" is 64 by that measure and 192 on the wire - past a cap whose entire
  // reason is the receiver's byte-measured body limit. The bash siblings use
  // jq's utf8bytelength for the same reason.
  if (Buffer.byteLength(raw, "utf8") > MAX_RELAYED_VALUE_LENGTH) return null;
  // A NUL cannot round-trip through the shell-based siblings and has no place
  // in a coarse enum here either; dropped whole so the relay stays
  // verbatim-or-nothing rather than silently sanitised.
  if (raw.includes("\u0000")) return null;
  return raw;
}

/**
 * Best-effort enrichment for the usage heartbeat: read the configured
 * AxonFlow platform's version, and the licence tier it reports about itself,
 * so the heartbeat can record which platform build the plugin is talking to
 * and under which edition it is running.
 *
 * This is part of the heartbeat, not a separate feature: it only runs after
 * `sendInner` has already passed the `AXONFLOW_TELEMETRY` opt-out check, so
 * setting `AXONFLOW_TELEMETRY=off` suppresses this probe along with the
 * heartbeat itself. It is a single unauthenticated GET to the same endpoint
 * the plugin already calls for policy enforcement, sends no request body, and
 * swallows any error (returns nulls) so it can never block or fail the
 * heartbeat.
 *
 * ONE request, both fields. `license_tier` rides the probe that already
 * existed; a second round trip would make it a new data collection rather
 * than a new field on an existing one.
 */
async function detectPlatformInfo(endpoint: string): Promise<PlatformInfo> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const resp = await fetch(`${endpoint}/health`, {
      method: "GET",
      signal: controller.signal,
      // `fetch` FOLLOWS redirects by default. Without this a /health that
      // redirects would have the plugin relay values read from whatever host
      // the configured endpoint pointed at - breaking the disclosure that they
      // are what YOUR platform reported, with the endpoint's operator choosing
      // who supplies them. "error" makes a redirect throw into the catch below,
      // which is the same fail-open path as any other probe failure.
      redirect: "error",
    });
    clearTimeout(timeoutId);
    // A non-2xx body is not an answer: it contributes neither field rather
    // than having its error body parsed for one.
    if (!resp.ok) return NO_PLATFORM_INFO;
    // No size cap on the body, deliberately: a real /health is ~6 KB and is
    // dominated by a `capabilities` map that grows every release, so any cap
    // we picked would eventually start silently dropping BOTH fields with no
    // diagnostic. The endpoint is the user's own configured agent, and the
    // only part that reaches the wire is the tier string, which IS
    // length-capped below.
    const body = (await resp.json()) as Record<string, unknown> | null;
    // Defence in depth, and deliberately NOT load-bearing: `typeof null ===
    // "object"` and an array is an object too, but indexing any of these for
    // `.version` / `.tier` already yields undefined (or, for null, throws into
    // the catch below), so removing this guard changes no observable outcome
    // today. It is here to make the non-object case explicit rather than
    // accidental — a later narrowing of the catch would otherwise regress the
    // null-body path silently. The mutation gate plants its removal as a
    // must-SURVIVE control, so if this ever becomes load-bearing the gate says so.
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return NO_PLATFORM_INFO;
    }
    // A required string arriving as a number, boolean, object or null is
    // invisible to any decoder that coerces. The type is checked, not assumed,
    // and every member is promoted INDEPENDENTLY: a badly-typed `tier` must
    // not be able to cost `version`, a field that worked before the tier
    // existed.
    const version = relayedValue(body, "version");
    const licenseTier = relayedValue(body, "tier");
    const edition = relayedValue(body, "edition");
    const platformDeploymentMode = relayedValue(body, "deployment_mode");
    return { version, licenseTier, edition, platformDeploymentMode };
  } catch {
    clearTimeout(timeoutId);
    return NO_PLATFORM_INFO;
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

  // 4. Detect platform version + licence tier from ONE /health probe
  // (best-effort). detectPlatformInfo already swallows its own errors; this
  // catch is the belt to that braces, so an unforeseen throw still leaves the
  // heartbeat itself intact rather than taking it down with the enrichment.
  const probeEndpoint = resolveProbeEndpoint(options.endpoint);
  let platformInfo: PlatformInfo = NO_PLATFORM_INFO;
  try {
    platformInfo = await detectPlatformInfo(probeEndpoint);
  } catch {
    platformInfo = NO_PLATFORM_INFO;
  }
  const platformVersion = platformInfo.version;

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
    // Spread, not `license_tier: platformInfo.licenseTier ?? undefined`: an
    // explicit `undefined` property still exists on the object, and while
    // JSON.stringify happens to drop it today, the distinction the receiver
    // reads is key-present vs key-absent. Building the key only when there is
    // a value to put in it makes the absence structural rather than incidental.
    ...(platformInfo.licenseTier ? { license_tier: platformInfo.licenseTier } : {}),
    ...(platformInfo.edition ? { edition: platformInfo.edition } : {}),
    ...(platformInfo.platformDeploymentMode
      ? { platform_deployment_mode: platformInfo.platformDeploymentMode }
      : {}),
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
      // A redirected POST is NOT a delivery, and following one is worse than
      // failing: `fetch` re-issues a redirected POST as a bodyless GET, so a
      // checkpoint URL answering 302 would return an `ok` response carrying
      // nothing, `delivered` would be true, and the 7-day stamp would advance
      // on a ping the receiver never saw - taking this machine dark for a
      // week (sdk-rust#89). "error" throws instead, and the stamp stays put.
      redirect: "error",
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
