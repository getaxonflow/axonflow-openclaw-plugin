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
}

/** Validate plugin config and return defaults. */
export function resolveConfig(
  raw: Record<string, unknown> | undefined,
): AxonFlowPluginConfig {
  if (!raw) {
    throw new Error(
      "AxonFlow plugin requires configuration. Set endpoint, clientId, and clientSecret in your OpenClaw plugin config.",
    );
  }

  const endpoint = raw["endpoint"];
  if (typeof endpoint !== "string" || !endpoint) {
    throw new Error("AxonFlow plugin: 'endpoint' is required (e.g., 'http://localhost:8080')");
  }

  // Defaults match SDK behavior: community mode works out of the box.
  // Override with your evaluation/enterprise license credentials.
  const rawClientId = typeof raw["clientId"] === "string" ? raw["clientId"] : "";
  const rawClientSecret = typeof raw["clientSecret"] === "string" ? raw["clientSecret"] : "";

  // Reject clientSecret without clientId — licensed mode must specify the tenant
  if (!rawClientId && rawClientSecret) {
    throw new Error(
      "AxonFlow plugin: 'clientId' is required when 'clientSecret' is set. " +
      "Set clientId to your tenant identity (e.g., your deployment's AXONFLOW_CLIENT_ID)."
    );
  }

  const clientId = rawClientId || "community";
  const clientSecret = rawClientSecret;

  return {
    endpoint,
    clientId,
    clientSecret,
    highRiskTools: Array.isArray(raw["highRiskTools"])
      ? (raw["highRiskTools"] as string[])
      : [],
    governedTools: Array.isArray(raw["governedTools"])
      ? (raw["governedTools"] as string[])
      : [],
    excludedTools: Array.isArray(raw["excludedTools"])
      ? (raw["excludedTools"] as string[])
      : [],
    defaultOperation:
      typeof raw["defaultOperation"] === "string"
        ? raw["defaultOperation"]
        : "execute",
    onError:
      raw["onError"] === "allow" ? "allow" : "block",
    requestTimeoutMs:
      typeof raw["requestTimeoutMs"] === "number" &&
      Number.isFinite(raw["requestTimeoutMs"]) &&
      raw["requestTimeoutMs"] > 0
        ? raw["requestTimeoutMs"]
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
