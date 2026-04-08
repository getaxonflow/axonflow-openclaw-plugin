/**
 * before_tool_call hook — input governance.
 *
 * Evaluates tool arguments against AxonFlow policies before execution.
 * Can block the call, require human approval, or allow through.
 */

import type { AxonFlowClient } from "./axonflow-client.js";
import type { AxonFlowPluginConfig } from "./config.js";
import { shouldGovernTool } from "./config.js";
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
 * 1. If the error exposes `.status` or `.statusCode` === 401/403 → auth.
 *    (v1.2.1 prefers this path — the AxonFlowHttpError class exported from
 *    `axonflow-client.ts` always exposes `.status`, so new code paths never
 *    need to fall through to message matching.)
 * 2. Otherwise, regex-match the error message against AUTH_ERROR_PATTERN
 *    with word-boundary anchors. Still needed because thrown errors from
 *    third-party fetch wrappers and legacy code may not expose `.status`.
 * 3. Everything else is a network/transient error — fail-open.
 *
 * Used by the fail-open / fail-closed decision in the before_tool_call
 * hook handler.
 */
export function isAxonFlowAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  // Preferred path: typed error with HTTP status.
  const maybeStatus =
    (err as { status?: number; statusCode?: number }).status ??
    (err as { status?: number; statusCode?: number }).statusCode;
  if (maybeStatus === 401 || maybeStatus === 403) return true;

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
  client: AxonFlowClient,
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
    const connectorType = deriveConnectorType(event.toolName);
    const statement = JSON.stringify(event.params);

    let check;
    try {
      check = await client.mcpCheckInput(
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
      return {
        block: true,
        blockReason: check.block_reason ?? "Blocked by AxonFlow policy",
      };
    }

    // High-risk tools get approval even when policy allows
    if (
      config.highRiskTools &&
      config.highRiskTools.includes(event.toolName)
    ) {
      recordToolCallApprovalRequired();
      return {
        requireApproval: {
          title: `AxonFlow: ${event.toolName} requires approval`,
          description: `Tool call governed by AxonFlow. ${check.policies_evaluated} policies evaluated.`,
          severity: "warning",
          timeoutMs: 60_000,
          timeoutBehavior: "deny",
        },
      };
    }

    recordToolCallAllowed();
    return undefined;
  };
}
