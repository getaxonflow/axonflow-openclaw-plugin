/**
 * after_tool_call hook — audit logging.
 *
 * Records every tool execution to AxonFlow's audit trail.
 * Fire-and-forget: audit failures do not block tool execution.
 */

import type { AxonFlowClient } from "./axonflow-client.js";
import type { AxonFlowPluginConfig } from "./config.js";
import { shouldGovernTool } from "./config.js";

/**
 * Create the after_tool_call hook handler.
 *
 * Logs tool execution details to AxonFlow for compliance audit.
 */
export function createAfterToolCallHandler(
  client: AxonFlowClient,
  config: AxonFlowPluginConfig,
) {
  return async (event: {
    toolName: string;
    params: Record<string, unknown>;
    runId?: string;
    toolCallId?: string;
    result?: unknown;
    error?: string;
    durationMs?: number;
  }): Promise<void> => {
    if (!shouldGovernTool(event.toolName, config)) {
      return;
    }

    try {
      await client.auditToolCall(
        event.toolName,
        event.params,
        event.result,
        event.error,
        event.durationMs,
      );
    } catch {
      // Fire-and-forget: audit failures must not interfere with tool pipeline
    }
  };
}
