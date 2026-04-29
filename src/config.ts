/**
 * Configuration for the AxonFlow governance plugin.
 *
 * All configuration is read from the OpenClaw plugin config system
 * (openclaw.plugin.json or runtime config).
 */

export interface AxonFlowPluginConfig {
  /** AxonFlow agent gateway endpoint (e.g., "http://localhost:8080"). */
  endpoint: string;

  /** Tenant identity for data isolation. Defaults to "community" for community mode. */
  clientId: string;

  /** License key for evaluation/enterprise features. Empty for community mode. */
  clientSecret: string;

  /**
   * Per-user identity forwarded on every request via X-User-Email.
   *
   * Required (and only required) when you want user-scoped AxonFlow
   * features to work through this plugin:
   *   - `createOverride` / `revokeOverride` / `listOverrides`
   *     (endpoint requires an authenticated user identity per ADR-044)
   *   - `explainDecision` historical_hit_count scoping
   *   - per-user override enforcement on block paths
   *
   * If unset, block responses still include decision_id + risk_level
   * + policy_matches, but the override lifecycle methods will reject
   * with HTTP 401 and explain's hit-count will aggregate across users.
   *
   * A reasonable default for CLI/local-agent setups is `os.userInfo().username`
   * + the agent hostname; a reasonable default for multi-tenant SaaS
   * deployments is the end-user's authenticated email.
   */
  userEmail?: string;

  /**
   * Tools that require human approval even when AxonFlow allows them.
   * Uses OpenClaw's native approval flow (Telegram/Discord/approve command).
   */
  highRiskTools?: string[];

  /**
   * Tools to govern. If empty, ALL tools are governed.
   * Use this to selectively enable governance on specific tools.
   */
  governedTools?: string[];

  /**
   * Tools to exclude from governance. Takes precedence over governedTools.
   */
  excludedTools?: string[];

  /**
   * Operation type sent to mcp_check_input.
   * Defaults to "execute". Set to "query" for read-only tool setups.
   */
  defaultOperation?: string;

  /**
   * Behavior when AxonFlow is unreachable (network error, timeout).
   * - "block" (default): treat errors as policy blocks (fail-closed)
   * - "allow": allow tool execution to proceed (fail-open)
   *
   * Fail-open prevents AxonFlow outages from breaking all tool execution.
   * Fail-closed is safer but can cascade AxonFlow failures to the agent.
   */
  onError?: "block" | "allow";

  /**
   * Timeout for AxonFlow HTTP calls in milliseconds.
   * Applies to policy checks, output scans, audit writes, and health checks.
   * Defaults to 8000ms.
   */
  requestTimeoutMs?: number;

  /**
   * Resolved deployment mode (set by `resolveConfig`):
   *   - "community-saas": user provided no explicit endpoint/clientId/clientSecret;
   *     plugin will register against try.getaxonflow.com on first run.
   *   - "self-hosted": user provided at least one of endpoint/clientId/clientSecret;
   *     plugin uses those values verbatim (no Community-SaaS bootstrap).
   *
   * Surfaced on the config so callers can emit the mode-clarity canary
   * "[AxonFlow] Connected to AxonFlow at <URL> (mode=<X>)" and so the
   * Gate 4 mode-clarity test can assert it.
   */
  mode: "community-saas" | "self-hosted";
}

const COMMUNITY_SAAS_DEFAULT_ENDPOINT = "https://try.getaxonflow.com";

/**
 * Validate plugin config and return defaults.
 *
 * Resolution order (ADR-048):
 *   1. If the user provided ANY of endpoint, clientId, clientSecret → mode is
 *      "self-hosted". Defaults are filled in: endpoint defaults to localhost,
 *      clientId defaults to "community", clientSecret stays empty (community
 *      mode). The user's explicit values are honoured untouched.
 *   2. If the user provided NONE → mode is "community-saas". Endpoint
 *      defaults to https://try.getaxonflow.com. clientId/clientSecret stay
 *      EMPTY here — the caller (registerAxonFlowGovernance) is expected to
 *      bootstrap the registration via community-saas-bootstrap.ts and
 *      override clientId/clientSecret on the resulting client.
 */
export function resolveConfig(
  raw: Record<string, unknown> | undefined,
): AxonFlowPluginConfig {
  const safe = raw ?? {};

  const rawEndpoint = typeof safe["endpoint"] === "string" ? (safe["endpoint"] as string).trim() : "";
  const rawClientId = typeof safe["clientId"] === "string" ? (safe["clientId"] as string).trim() : "";
  const rawClientSecret = typeof safe["clientSecret"] === "string" ? (safe["clientSecret"] as string).trim() : "";

  // Reject clientSecret without clientId regardless of mode — licensed
  // setups must specify the tenant identity.
  if (!rawClientId && rawClientSecret) {
    throw new Error(
      "AxonFlow plugin: 'clientId' is required when 'clientSecret' is set. " +
      "Set clientId to your tenant identity (e.g., your deployment's AXONFLOW_CLIENT_ID)."
    );
  }

  const userProvidedAnything =
    rawEndpoint !== "" || rawClientId !== "" || rawClientSecret !== "";

  let endpoint: string;
  let clientId: string;
  let clientSecret: string;
  let mode: "community-saas" | "self-hosted";

  if (userProvidedAnything) {
    mode = "self-hosted";
    // Endpoint default for self-hosted users who set credentials but not
    // endpoint: assume the canonical local-agent URL. Matches the bash
    // plugins' resolution rule.
    endpoint = rawEndpoint || "http://localhost:8080";
    clientId = rawClientId || "community";
    clientSecret = rawClientSecret;
  } else {
    mode = "community-saas";
    endpoint = COMMUNITY_SAAS_DEFAULT_ENDPOINT;
    // Bootstrap will fill these in. We deliberately leave them empty here
    // so a misconfigured caller that skips the bootstrap step gets a clear
    // 401 from the agent rather than a half-credentialled request.
    clientId = "";
    clientSecret = "";
  }

  return {
    endpoint,
    clientId,
    clientSecret,
    mode,
    userEmail:
      typeof safe["userEmail"] === "string" && (safe["userEmail"] as string).trim()
        ? (safe["userEmail"] as string).trim()
        : undefined,
    highRiskTools: Array.isArray(safe["highRiskTools"])
      ? (safe["highRiskTools"] as string[])
      : [],
    governedTools: Array.isArray(safe["governedTools"])
      ? (safe["governedTools"] as string[])
      : [],
    excludedTools: Array.isArray(safe["excludedTools"])
      ? (safe["excludedTools"] as string[])
      : [],
    defaultOperation:
      typeof safe["defaultOperation"] === "string"
        ? (safe["defaultOperation"] as string)
        : "execute",
    onError:
      safe["onError"] === "allow" ? "allow" : "block",
    requestTimeoutMs:
      typeof safe["requestTimeoutMs"] === "number" &&
      Number.isFinite(safe["requestTimeoutMs"]) &&
      (safe["requestTimeoutMs"] as number) > 0
        ? (safe["requestTimeoutMs"] as number)
        : 8000,
  };
}

/** Check if a tool should be governed based on config. */
export function shouldGovernTool(
  toolName: string,
  config: AxonFlowPluginConfig,
): boolean {
  // Excluded tools take precedence
  if (config.excludedTools && config.excludedTools.includes(toolName)) {
    return false;
  }
  // If governedTools is specified, only those are governed
  if (config.governedTools && config.governedTools.length > 0) {
    return config.governedTools.includes(toolName);
  }
  // Default: govern all tools
  return true;
}
