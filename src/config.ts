/**
 * Configuration for the AxonFlow governance plugin.
 *
 * All configuration is read from the OpenClaw plugin config system
 * (openclaw.plugin.json or runtime config).
 */

export interface AxonFlowPluginConfig {
  /** AxonFlow agent gateway endpoint (e.g., "http://localhost:8080"). */
  endpoint: string;

  /** AxonFlow client ID for authentication. */
  clientId: string;

  /** AxonFlow client secret for authentication. */
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

  const clientId = raw["clientId"];
  if (typeof clientId !== "string" || !clientId) {
    throw new Error("AxonFlow plugin: 'clientId' is required");
  }

  const clientSecret = raw["clientSecret"];
  if (typeof clientSecret !== "string" || !clientSecret) {
    throw new Error("AxonFlow plugin: 'clientSecret' is required");
  }

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
