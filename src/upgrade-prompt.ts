/**
 * V1 Plugin Pro upgrade-prompt envelope handling
 * (umbrella getaxonflow/axonflow-enterprise#1958).
 *
 * The agent emits a structured upgrade-prompt envelope on every
 * customer-facing limit hit (429 daily-quota, 403 graduated / Pro-only).
 * Locked shape per
 * `axonflow-enterprise/platform/agent/community_saas_ratelimit_response.go`:
 *
 *   {
 *     error: string,
 *     limit_type: "daily_quota" | "active_policies" | "hitl_approvals_window" | "feature_pro_only",
 *     tier: "Free" | "Pro" | "Premium" | "Enterprise",
 *     limit: number,
 *     remaining: number,
 *     window?: "daily_utc" | "rolling_7d",
 *     resets_at?: string,    // RFC3339
 *     upgrade: {
 *       tier: "Pro",
 *       wording: string,     // ≤200 chars, locked V1 wording
 *       compare_url: string, // https://getaxonflow.com/pricing/
 *       buy_url: string,     // https://buy.stripe.com/bJe28qbztcdVchjdkw8k800
 *     }
 *   }
 *
 * The 5 V1 Pro MCP tools (axonflow_create_tenant_policy etc.) deliver
 * the same envelope wrapped inside a JSON-RPC `result.content[0].text`
 * blob with `isError: true` (see writeMCPGateError in
 * mcp_v1_pro_tools.go). The dual-shape parser in this module accepts
 * both bare and wrapped shapes.
 *
 * Surfacing rules:
 *   - The wording is logged via the host plugin logger at most once per
 *     UTC day (stamp file at `${cacheDir}/upgrade-prompt-last-shown`).
 *   - A throttle deadline file is stamped at `${cacheDir}/throttle-until`
 *     so subsequent governed calls can short-circuit locally without
 *     re-hammering the agent during the back-off window.
 *
 * Doctrine: `feedback_429_no_upgrade_hint_is_conversion_gap.md` —
 * every Free-tier limit hit pre-V1 was a Pro conversion target lost
 * because the response body was bare and the plugin had no way to
 * surface it. This module closes that gap.
 */
import * as fs from "fs";
import * as path from "path";

import { axonflowCacheDir } from "./cache-dir.js";

/** Locked V1 limit-type identifiers (mirror of LimitType* constants in
 * platform/agent/community_saas_ratelimit_response.go AND the V1.1
 * limitTypeDecisionListSize in platform/orchestrator/decisions_list_handler.go).
 * Adding a value here is required for `handleEnvelope` to recognize that
 * limit_type — unrecognized types short-circuit the throttle gate and the
 * upgrade wording is silently dropped. */
export const V1_LIMIT_TYPES = [
  "daily_quota",
  "active_policies",
  "hitl_approvals_window",
  "feature_pro_only",
  "decision_list_size",
] as const;

export type V1LimitType = typeof V1_LIMIT_TYPES[number];

export interface V1UpgradeBlock {
  tier: string;
  wording: string;
  compare_url: string;
  buy_url: string;
}

export interface V1RateLimitEnvelope {
  error: string;
  limit_type: V1LimitType;
  tier: string;
  limit: number;
  remaining: number;
  window?: string;
  resets_at?: string;
  upgrade: V1UpgradeBlock;
}

/** Shape of the JSON-RPC wrapper used by the MCP path. The `text` field
 * carries the V1 envelope as a JSON-encoded string. */
interface JsonRpcWrappedEnvelope {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
}

/** Minimal logger interface — matches the plugin's existing api.logger
 * shape so callers can pass it through unchanged. */
export interface UpgradePromptLogger {
  info(msg: string): void;
  warn?(msg: string): void;
  error(msg: string): void;
}

/** Detect the V1 envelope on a parsed response body. Accepts both bare
 * envelopes (HTTP 429 / 403 path) and JSON-RPC wrapped envelopes (MCP
 * tier-gate path). Returns the envelope object on match, null otherwise. */
export function detectEnvelope(
  body: unknown,
): V1RateLimitEnvelope | null {
  if (body == null || typeof body !== "object") {
    return null;
  }
  const obj = body as Record<string, unknown>;

  // Direct/bare shape: { error, limit_type, tier, upgrade, ... }
  if (typeof obj["limit_type"] === "string" && obj["upgrade"] != null) {
    return obj as unknown as V1RateLimitEnvelope;
  }

  // JSON-RPC wrapped: result.content[0].text contains the envelope JSON.
  const wrapped = body as JsonRpcWrappedEnvelope;
  const text = wrapped.result?.content?.[0]?.text;
  if (typeof text === "string" && text.length > 0) {
    try {
      const inner = JSON.parse(text) as Record<string, unknown>;
      if (typeof inner["limit_type"] === "string" && inner["upgrade"] != null) {
        return inner as unknown as V1RateLimitEnvelope;
      }
    } catch {
      // Not JSON — fall through.
    }
  }

  return null;
}

/** Convert a Retry-After header value to milliseconds (whole-seconds form
 * only — HTTP-date form is accepted but parsed leniently). Returns null
 * if the header is missing / malformed. */
export function retryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

/** Resolve the deadline epoch (ms) the throttle gate should honour from
 * (in priority order):
 *   1. envelope.resets_at — clock-driven; the cap clears at this time.
 *   2. Retry-After header — server-suggested backoff.
 *   3. Fallback 60s cooldown — for object-count limits + feature_pro_only
 *      that have no clock; ensures the plugin doesn't immediately retry
 *      and start a tight loop. */
export function resolveDeadlineMs(
  envelope: V1RateLimitEnvelope,
  retryAfterHeader: string | null | undefined,
  now: number = Date.now(),
): number {
  if (envelope.resets_at) {
    const ts = Date.parse(envelope.resets_at);
    if (!Number.isNaN(ts) && ts > now) {
      return ts;
    }
  }
  const retryMs = retryAfterMs(retryAfterHeader);
  if (retryMs !== null && retryMs > 0) {
    return now + retryMs;
  }
  return now + 60_000;
}

/** Returns true if a throttle stamp exists with a future deadline.
 * Caller should fall through (no outbound governed call) when this
 * returns true. Cleans up expired stamps as a side effect. */
export function isThrottleActive(
  cacheDir: string = axonflowCacheDir(),
  now: number = Date.now(),
): boolean {
  if (!cacheDir) return false;
  const file = path.join(cacheDir, "throttle-until");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  const epochSeconds = parseInt(firstLine.split(/\s+/)[0] ?? "", 10);
  if (Number.isNaN(epochSeconds) || epochSeconds <= 0) {
    safeUnlink(file);
    return false;
  }
  if (epochSeconds * 1000 <= now) {
    safeUnlink(file);
    return false;
  }
  return true;
}

/** Stamp the throttle deadline file. Format: `<epoch-seconds> <limit_type>\n`. */
export function stampThrottle(
  cacheDir: string,
  deadlineMs: number,
  limitType: V1LimitType,
): void {
  if (!cacheDir) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }
  const epoch = Math.floor(deadlineMs / 1000);
  const file = path.join(cacheDir, "throttle-until");
  try {
    fs.writeFileSync(file, `${epoch} ${limitType}\n`, { mode: 0o600 });
  } catch {
    // Cache write failed — degrade silently. The wording was already
    // surfaced via the logger, the worst that happens is the next
    // governed call retries instead of short-circuiting.
  }
}

/** Returns true if the once-per-UTC-day stamp says we have NOT shown the
 * upgrade prompt today. Stamps today's date as a side-effect when it
 * returns true. */
export function shouldShowPromptToday(
  cacheDir: string,
  now: Date = new Date(),
): boolean {
  if (!cacheDir) return true;
  const file = path.join(cacheDir, "upgrade-prompt-last-shown");
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
  try {
    const last = fs.readFileSync(file, "utf8").trim();
    if (last === today) return false;
  } catch {
    // No stamp → first run today → fall through to write + return true.
  }
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${today}\n`, { mode: 0o600 });
  } catch {
    // Stamp write failed — degrade silently. The prompt may re-fire on
    // the next call; not great but not broken.
  }
  return true;
}

/** Result of `handleEnvelope` — caller branches on `detected` and can
 * stop the current operation when true (the cap was hit; the wording
 * has been surfaced; the throttle gate has been stamped). */
export interface HandleEnvelopeResult {
  detected: boolean;
  envelope?: V1RateLimitEnvelope;
  /** UTC epoch seconds when the throttle deadline expires. Useful for
   * downstream code that wants to surface the deadline differently
   * (e.g. retry-with-backoff queues). */
  deadlineEpoch?: number;
  /** True when the wording was surfaced to the logger on this call.
   * False when the once-per-day stamp suppressed it. */
  wordingSurfaced?: boolean;
}

/**
 * Detect + handle a V1 envelope on a non-2xx response. When detected:
 *   - logs `upgrade.wording` + buy URL via the supplied logger (gated by
 *     the once-per-UTC-day stamp),
 *   - stamps the throttle deadline file based on resets_at / Retry-After,
 *   - returns `{ detected: true, envelope, deadlineEpoch, wordingSurfaced }`.
 *
 * On legacy responses (no envelope shape) returns `{ detected: false }`
 * so callers can fall back to existing 429 / 403 handling unchanged.
 *
 * Pure-function dependencies (cacheDir + clock) are injectable so unit
 * tests can run hermetically without OS state.
 */
export function handleEnvelope(opts: {
  status: number;
  body: unknown;
  retryAfterHeader?: string | null;
  logger: UpgradePromptLogger;
  cacheDir?: string;
  now?: Date;
}): HandleEnvelopeResult {
  const { status, body, retryAfterHeader, logger } = opts;
  const cacheDir = opts.cacheDir ?? axonflowCacheDir();
  const now = opts.now ?? new Date();

  // Three envelope-bearing paths:
  //   - HTTP 429 (daily-quota path on apiAuthMiddleware).
  //   - HTTP 403 (graduated cap / Pro-only on REST endpoints).
  //   - HTTP 200 + JSON-RPC `result.isError = true` (the MCP tools/call
  //     gate path emits the envelope wrapped in JSON-RPC result; the
  //     transport-level status stays 200 because the envelope is the
  //     tool result, not a transport error).
  // Other statuses fall through to the caller's existing logic.
  const isJsonRpcGateError =
    status === 200 &&
    body !== null &&
    typeof body === "object" &&
    (body as Record<string, unknown>)["result"] !== undefined &&
    ((body as Record<string, unknown>)["result"] as Record<string, unknown>)?.["isError"] === true;
  if (status !== 429 && status !== 403 && !isJsonRpcGateError) {
    return { detected: false };
  }

  const envelope = detectEnvelope(body);
  if (!envelope) {
    return { detected: false };
  }
  if (!V1_LIMIT_TYPES.includes(envelope.limit_type)) {
    // Unknown limit_type — defensive guard. Don't stamp; let caller fall
    // back to legacy handling so a future server-side limit_type rollout
    // doesn't accidentally trip the throttle gate against an old plugin.
    return { detected: false };
  }

  const deadlineMs = resolveDeadlineMs(envelope, retryAfterHeader, now.getTime());
  stampThrottle(cacheDir, deadlineMs, envelope.limit_type);

  const wordingSurfaced = shouldShowPromptToday(cacheDir, now);
  if (wordingSurfaced) {
    const wording = envelope.upgrade?.wording || envelope.error
      || "Free-tier limit reached on AxonFlow. Pro removes this cap.";
    const buy = envelope.upgrade?.buy_url || "https://getaxonflow.com/pricing/";
    logger.info(`[AxonFlow] ${wording}`);
    logger.info(`[AxonFlow] Upgrade: ${buy}`);
  }

  return {
    detected: true,
    envelope,
    deadlineEpoch: Math.floor(deadlineMs / 1000),
    wordingSurfaced,
  };
}

/** Test-only helper exposed for the unit suite — wraps the safe-unlink
 * idiom used by isThrottleActive when the stamp is malformed/expired. */
function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}
