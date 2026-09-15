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
import { AxonFlowLimitError } from "./axonflow-client.js";
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
  const maybeStatus = statusOf(err);
  if (maybeStatus !== undefined) {
    return maybeStatus === 401 || maybeStatus === 403;
  }

  // Fallback: message-based pattern match with word boundaries.
  const message =
    err instanceof Error ? err.message : String(err);
  return AUTH_ERROR_PATTERN.test(message);
}

/**
 * The HTTP status a thrown error exposes (`.status`, else `.statusCode`), when
 * it is a finite number; undefined otherwise.
 */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const maybeStatus =
    (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { status?: unknown; statusCode?: unknown }).statusCode;
  return typeof maybeStatus === "number" && Number.isFinite(maybeStatus)
    ? maybeStatus
    : undefined;
}

/**
 * The rows of the failure posture a thrown governance check can land in (#196):
 *
 *   limit        an AxonFlowLimitError (an HTTP 429, a V1 limit envelope, or
 *                the back-off an earlier limit stamped), or any status 429
 *   refused      an HTTP 3xx, or a 4xx other than 408 and 429: the endpoint,
 *                the credential or the configuration refused the check (a
 *                403 carrying a policy decision never throws; it is the deny)
 *   unavailable  no usable answer: an HTTP 408, a 5xx, a 2xx that was not a
 *                JSON object, a network error or timeout
 *
 * An error that exposes no status is refused when its message reads as an
 * auth error (isAxonFlowAuthError) and unavailable otherwise. The pre-tool hook
 * reads `limit` and `refused` through config.onError and `unavailable` through
 * config.failMode; message_sending reads all three through config.onError.
 */
export type GovernanceFailureClass = "limit" | "refused" | "unavailable";

export function classifyGovernanceFailure(err: unknown): GovernanceFailureClass {
  if (err instanceof AxonFlowLimitError) return "limit";
  if (!err || typeof err !== "object") return "unavailable";
  const maybeStatus = statusOf(err);
  if (maybeStatus !== undefined) {
    if (maybeStatus === 429) return "limit";
    if (maybeStatus === 408) return "unavailable";
    if (maybeStatus >= 300 && maybeStatus < 500) return "refused";
    return "unavailable";
  }
  return isAxonFlowAuthError(err) ? "refused" : "unavailable";
}

/**
 * Does this error already carry its own operator-visible notice?
 *
 * `AxonFlowClient.markAuthFailed()` — the ONE place the client emits its
 * one-shot auth warning — fires from the `fetchWithTimeout` chokepoint on
 * `response.status === 401` only, and the circuit-breaker short-circuit
 * rethrows a synthetic error that also carries `status: 401`. So exactly the
 * status-401 shape is guaranteed to have been announced.
 *
 * Everything else in the auth class — a thrown 403, or a message-classified
 * error that exposes no status at all — never trips `markAuthFailed`. Under
 * `onError: "allow"` those paths used to proceed ungoverned with NO signal
 * (#170); the before_tool_call handler now announces the ungoverned outcome
 * for them via `noteUngovernedFailOpen`, keeping the 401 path's semantics
 * (client notice only, no second warning) unchanged.
 */
export function carriesOwnAuthNotice(err: unknown): boolean {
  return statusOf(err) === 401;
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

    // The V1 back-off an earlier limit stamped is read by mcpCheckInput itself,
    // which refuses the check as a limit (AxonFlowLimitError) without sending
    // a request. A second gate here used to let the call run (#196).

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

      // The failure posture (#196, classifyGovernanceFailure):
      //   - no usable answer (timeout, DNS failure, connection refused, 408,
      //     5xx): config.failMode decides. "open" (the default) lets the call
      //     run with the one-shot notice; "closed" blocks it.
      //   - a limit (429, a V1 envelope, the back-off) and a refusal (3xx,
      //     4xx, an auth-classified error): config.onError decides, defaulting
      //     to "block"; "allow" lets the call run with the notice.
      // The endpoint is read off the CLIENT, not off `config`: in
      // community-saas mode registerAxonFlowGovernance swaps in a client
      // built on the endpoint the register response named, so `config`
      // can name a host the failing request never touched. Optional call
      // so test doubles without the accessor degrade to the config value.
      const failedEndpoint =
        (typeof clientRef.current.getEndpoint === "function"
          ? clientRef.current.getEndpoint()
          : "") || config.endpoint;

      const failure = classifyGovernanceFailure(err);
      const detail = err instanceof Error ? err.message : "unknown error";
      if (failure === "unavailable") {
        if (config.failMode === "closed") {
          recordToolCallBlocked();
          return {
            block: true,
            blockReason:
              `AxonFlow governance unavailable: ${detail}. failMode is "closed" ` +
              "(pluginConfig.failMode or AXONFLOW_FAIL_MODE), so this tool call is blocked.",
          };
        }
        // #167: announce once per process that governed calls are running
        // without policy evaluation, so a session cannot go ungoverned
        // without the user being told.
        noteUngovernedFailOpen(failedEndpoint, err);
        recordToolCallAllowed();
        return undefined;
      }

      // A limit or a refusal: config.onError decides (default "block").
      if (config.onError === "allow") {
        // #170: proceeding IS the ungoverned outcome. A status-401 stays quiet
        // here because the client's own one-shot notice (markAuthFailed)
        // already announced it; a limit and every other refusal announce it.
        if (!carriesOwnAuthNotice(err)) {
          noteUngovernedFailOpen(failedEndpoint, err);
        }
        recordToolCallAllowed();
        return undefined;
      }
      recordToolCallBlocked();
      if (failure === "limit") {
        return {
          block: true,
          blockReason: `AxonFlow request limit reached: ${detail}. This tool call is blocked until the limit resets.`,
        };
      }
      if (isAxonFlowAuthError(err)) {
        return {
          block: true,
          blockReason: `AxonFlow auth error: ${detail}. Fix configuration to restore tool access.`,
        };
      }
      return {
        block: true,
        blockReason:
          statusOf(err) === 402
            ? `AxonFlow refused the governance check: ${detail}. HTTP 402 is an AxonFlow tier limit on this client, not an endpoint or credential problem.`
            : `AxonFlow refused the governance check: ${detail}. Check the endpoint and the credentials to restore tool access.`,
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

    // #192: discharge a request-phase redaction by SUBSTITUTING the platform's
    // engine-masked statement for the caller's original parameters.
    //
    // ADR-056 forbids this plugin from redacting for itself, so substitution is
    // the only sanctioned discharge. Before this, the masked text was not read
    // at all and the tool ran on the original parameters.
    //
    // # WHY EVERY FAILURE HERE BLOCKS
    //
    // Three ways the substitution can fail to happen, and all three block
    // rather than proceed. Once the platform has told us a redaction applies,
    // running the tool on unmasked parameters is not a degraded outcome, it is
    // the outcome the redaction existed to prevent - so there is no arm of this
    // branch that continues with the original.
    //
    // `redaction_evaluated` is checked SEPARATELY from the presence of the
    // masked text, per the platform contract (#2563 B1): absent-or-false means
    // the redactor never ran, and "it found nothing" is then indistinguishable
    // from "it never looked". Collapsing the two is how content proceeds
    // unmasked under the belief that it was checked.
    if (typeof check.redacted_statement === "string") {
      if (check.redaction_evaluated !== true) {
        recordToolCallBlocked();
        return {
          block: true,
          blockReason:
            "AxonFlow returned a redacted statement but did not report the redaction " +
            "detector as having run, so the masked content cannot be trusted. " +
            "Blocking rather than proceeding." + formatRicherContext(check),
        };
      }
      let maskedParams: unknown;
      try {
        maskedParams = JSON.parse(check.redacted_statement);
      } catch {
        recordToolCallBlocked();
        return {
          block: true,
          blockReason:
            "AxonFlow returned a redacted statement this plugin could not parse back " +
            "into tool parameters, so the redaction cannot be applied. Blocking rather " +
            "than running the tool on unmasked input." + formatRicherContext(check),
        };
      }
      if (maskedParams === null || typeof maskedParams !== "object" || Array.isArray(maskedParams)) {
        recordToolCallBlocked();
        return {
          block: true,
          blockReason:
            "AxonFlow returned a redacted statement that is not a parameter object, " +
            "so the redaction cannot be applied. Blocking rather than running the tool " +
            "on unmasked input." + formatRicherContext(check),
        };
      }
      recordToolCallAllowed();
      // The SUBSTITUTION. OpenClaw runs the tool with these parameters instead
      // of event.params.
      return { params: maskedParams as Record<string, unknown> };
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
