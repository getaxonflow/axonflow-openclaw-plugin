/**
 * before_tool_call hook — input governance.
 *
 * Evaluates tool arguments against AxonFlow policies before execution.
 * Can block the call, require human approval, or allow through.
 */

import type { AxonFlowClient } from "./axonflow-client.js";
import type { AxonFlowPluginConfig } from "./config.js";
import { shouldGovernTool } from "./config.js";

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
      if (config.onError === "allow") {
        return undefined; // Fail-open: allow tool execution
      }
      return {
        block: true,
        blockReason: `AxonFlow unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }

    if (!check.allowed) {
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

    return undefined;
  };
}
