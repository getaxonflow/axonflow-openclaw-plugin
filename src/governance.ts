/**
 * before_tool_call hook — input governance.
 *
 * Evaluates tool arguments against AxonFlow policies before execution.
 * Can block the call, require human approval, or allow through.
 */

import type { MCPCheckInputResponse } from "./axonflow-client.js";
import type { ClientRef } from "./client-ref.js";
import type { AxonFlowPluginConfig } from "./config.js";
import { shouldGovernTool } from "./config.js";
import { noteUngovernedFailOpen } from "./fail-open-notice.js";
import {
  recordToolCallEvaluated,
  recordToolCallBlocked,
  recordToolCallApprovalRequired,
  recordToolCallAllowed,
  recordGovernanceError,
} from "./metrics.js";

/** Result type matching OpenClaw's PluginHookBeforeToolCallResult. */
export interface BeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
  };
}

/** Derive connector_type from tool name for AxonFlow policy evaluation. */
export function deriveConnectorType(toolName: string): string {
  return `openclaw.${toolName}`;
}

/**
 * Format the Plugin Batch 1 richer-context fields (decision_id, risk_level,
 * override availability, top matched policy) into a suffix users see in the
 * OpenClaw block message / approval dialog.
 *
 * Every field is optional (older AxonFlow platforms return undefined for all
 * of them). When no richer context is present, returns an empty string so
 * the caller can safely concatenate.
 *
 * Split out of the block/approval return sites so the same formatting is used
 * in both — so users see the same decision identifier + unblock path
 * regardless of whether they hit a deny or a highRiskTools approval gate.
 */
export function formatRicherContext(check: MCPCheckInputResponse): string {
  const parts: string[] = [];
  if (check.decision_id) parts.push(`decision: ${check.decision_id}`);
  if (check.risk_level) parts.push(`risk: ${check.risk_level}`);
  if (check.policy_matches && check.policy_matches.length > 0) {
    const first = check.policy_matches[0];
    if (first?.policy_name) parts.push(`policy: ${first.policy_name}`);
  }
  if (check.override_available === true) {
    if (check.override_existing_id) {
      parts.push(`active override: ${check.override_existing_id}`);
    } else {
      parts.push("override available via explain_decision MCP tool");
    }
  }
  return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
}

/**
 * Regex used by the auth-error classifier for message-based matching.
 *
 * v1.2.1 change: word-boundary anchors (`\b`) instead of raw substring
 * matches. The previous version's `.includes("auth")` accidentally matched
 * "author", "authority", "authoritative", etc. It also had a special-case
 * exclusion for "auth server" to work around that. With word boundaries,
 * the false positives go away and the special-case exclusion is no longer
 * needed.
 *
 * The pattern matches any of:
 *   \b401\b             — HTTP 401 as a standalone token
 *   \b403\b             — HTTP 403 as a standalone token
 *   \bunauthorized\b
 *   \bforbidden\b
 *   \bcredentials?\b
 *   \bauth(?:entication|orization)?\b  — "auth", "authentication", "authorization" but NOT "author" / "authoritative"
 *   \b(?:invalid|expired)[ _-]?token\b — "invalid token" / "expired token" / "invalid_token" / "expired-token"
 *   \btoken[ _-]?invalid\b             — "token invalid" / "token_invalid"
 */
const AUTH_ERROR_PATTERN = new RegExp(
  [
    "\\b401\\b",
    "\\b403\\b",
    "\\bunauthorized\\b",
    "\\bforbidden\\b",
    "\\bcredentials?\\b",
    "\\bauth(?:entication|orization)?\\b",
    "\\b(?:invalid|expired)[ _-]?token\\b",
    "\\btoken[ _-]?invalid\\b",
  ].join("|"),
  "i",
);

/**
 * Classify an error thrown by the AxonFlow client as an auth/config error
 * vs a transient network / server-side error.
 *
 * Decision order:
 * 1. If the error exposes a numeric `.status` / `.statusCode`, that status is
 *    AUTHORITATIVE: 401/403 is an auth error, anything else is not, and the
 *    message is never consulted.
 * 2. Only when no status is exposed — thrown errors from third-party fetch
 *    wrappers and legacy code — fall back to regex-matching the message with
 *    word-boundary anchors.
 * 3. Everything else is a network/transient error — fail-open.
 *
 * WHY THE STATUS SHORT-CIRCUITS BOTH WAYS (#167 R3). `AxonFlowHttpError`
 * carries the platform's own reason in its message. A transient 5xx whose
 * body happens to mention authentication — an ALB answering
 * `502 {"error":"upstream authentication service unavailable"}` is the
 * canonical case — would otherwise fall through to the message regex, be
 * classified as an auth error, skip the fail-open branch, and hard-block
 * every governed tool call under the default `onError: "block"`, telling the
 * operator to fix credentials that are fine. Server-controlled text must not
 * steer the fail-open/fail-closed decision when the status already answers it.
 *
 * Used by the fail-open / fail-closed decision in the before_tool_call
 * hook handler.
 */
export function isAxonFlowAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  // Preferred path: typed error with an HTTP status. Decisive in BOTH
  // directions — a non-auth status ends the classification here.
  const maybeStatus =
    (err as { status?: number; statusCode?: number }).status ??
    (err as { status?: number; statusCode?: number }).statusCode;
  if (typeof maybeStatus === "number" && Number.isFinite(maybeStatus)) {
    return maybeStatus === 401 || maybeStatus === 403;
  }

  // Fallback: message-based pattern match with word boundaries.
  const message =
    err instanceof Error ? err.message : String(err);
  return AUTH_ERROR_PATTERN.test(message);
}

/**
 * Create the before_tool_call hook handler.
 *
 * Decision logic:
 * 1. If tool is excluded from governance: allow through (no check)
 * 2. Call mcp_check_input with tool args serialized as JSON
 * 3. If blocked by policy: return { block: true, blockReason }
 * 4. If tool is in highRiskTools AND allowed: return { requireApproval }
 * 5. Otherwise: allow through
 */
export function createBeforeToolCallHandler(
  clientRef: ClientRef,
  config: AxonFlowPluginConfig,
) {
  return async (event: {
    toolName: string;
    params: Record<string, unknown>;
    runId?: string;
    toolCallId?: string;
  }): Promise<BeforeToolCallResult | undefined> => {
    if (!shouldGovernTool(event.toolName, config)) {
      return undefined;
    }

    recordToolCallEvaluated();

    // V1 Plugin Pro back-off gate. When a recent governed call returned
    // a 429 / 403 envelope, the throttle stamp suppresses outbound
    // traffic until the envelope's resets_at deadline. Fall open
    // immediately so the user's tool isn't held up while we wait the
    // cap out (the upgrade prompt was already surfaced when the
    // throttle landed).
    //
    // The optional-chaining call accommodates tests that pass a mock
    // client without the V1 helper — the gate degrades to "no
    // throttle in effect" rather than throwing.
    if (typeof clientRef.current.isV1ThrottleActive === "function"
        && clientRef.current.isV1ThrottleActive()) {
      recordToolCallAllowed();
      return undefined;
    }

    const connectorType = deriveConnectorType(event.toolName);
    const statement = JSON.stringify(event.params);

    let check;
    try {
      check = await clientRef.current.mcpCheckInput(
        connectorType,
        statement,
        config.defaultOperation ?? "execute",
      );
    } catch (err) {
      recordGovernanceError();

      // Issue #1545 Direction 3: classify the error to decide fail-open vs
      // fail-closed. Network errors (timeout, DNS failure, connection
      // refused, 5xx) always fail OPEN regardless of config.onError —
      // transient infrastructure issues should never block legitimate dev
      // workflows. Auth errors (401/403) respect config.onError, defaulting
      // to fail-closed because they indicate a misconfiguration the
      // operator can and should fix.
      const isAuthError = isAxonFlowAuthError(err);
      if (!isAuthError) {
        // #167: the fail-open POLICY above is unchanged; the silence is what
        // changes. Announce once per process that governed calls are running
        // without policy evaluation, so a session cannot go ungoverned
        // without the user being told. Auth errors are excluded — they take
        // the config.onError path below and carry their own notice.
        //
        // The endpoint is read off the CLIENT, not off `config`: in
        // community-saas mode registerAxonFlowGovernance swaps in a client
        // built on the endpoint the register response named, so `config`
        // can name a host the failing request never touched. Optional call
        // so test doubles without the accessor degrade to the config value.
        const failedEndpoint =
          (typeof clientRef.current.getEndpoint === "function"
            ? clientRef.current.getEndpoint()
            : "") || config.endpoint;
        noteUngovernedFailOpen(failedEndpoint, err);
        recordToolCallAllowed();
        return undefined; // Fail-open: transient network issue
      }

      // Auth error — respect config.onError (which defaults to "block").
      if (config.onError === "allow") {
        recordToolCallAllowed();
        return undefined;
      }
      recordToolCallBlocked();
      return {
        block: true,
        blockReason: `AxonFlow auth error: ${err instanceof Error ? err.message : "unknown error"}. Fix configuration to restore tool access.`,
      };
    }

    if (!check.allowed) {
      recordToolCallBlocked();
      const baseReason = check.block_reason ?? "Blocked by AxonFlow policy";
      return {
        block: true,
        blockReason: baseReason + formatRicherContext(check),
      };
    }

    // High-risk tools get approval even when policy allows
    if (
      config.highRiskTools &&
      config.highRiskTools.includes(event.toolName)
    ) {
      recordToolCallApprovalRequired();
      // Map platform risk_level (low|medium|high|critical) to OpenClaw's
      // approval severity (info|warning|critical). When the platform doesn't
      // surface risk_level, fall back to warning to preserve v1.2.x behavior.
      let severity: "info" | "warning" | "critical" = "warning";
      if (check.risk_level === "critical" || check.risk_level === "high") {
        severity = "critical";
      } else if (check.risk_level === "low") {
        severity = "info";
      }
      return {
        requireApproval: {
          title: `AxonFlow: ${event.toolName} requires approval`,
          description:
            `Tool call governed by AxonFlow. ${check.policies_evaluated} policies evaluated.` +
            formatRicherContext(check),
          severity,
          timeoutMs: 60_000,
          timeoutBehavior: "deny",
        },
      };
    }

    recordToolCallAllowed();
    return undefined;
  };
}
