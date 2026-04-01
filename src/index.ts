/**
 * AxonFlow Governance Plugin for OpenClaw
 *
 * Adds centralized policy enforcement, PII detection, and audit trails
 * to OpenClaw tool execution. Works with all OpenClaw tools: built-in,
 * plugin-provided, and MCP-backed.
 *
 * Install:
 *   openclaw plugins install @axonflow/openclaw
 *
 * Configure in your OpenClaw config:
 *   plugins:
 *     @axonflow/openclaw:
 *       endpoint: http://localhost:8080
 *       clientId: your-client-id
 *       clientSecret: your-secret
 *       highRiskTools:
 *         - web_fetch
 *         - message
 *
 * What this plugin does (5 hooks):
 * 1. before_tool_call: evaluates tool arguments against AxonFlow policies
 * 2. after_tool_call: logs tool execution to AxonFlow's audit trail
 * 3. message_sending: scans outbound messages, cancels or redacts PII
 * 4. llm_input: records prompt, model, provider to audit trail
 * 5. llm_output: records response, token usage, latency to audit trail
 *
 * Note: tool_result_persist (output scanning) is not registered because
 * OpenClaw's hook is sync-only and cannot make async HTTP calls to AxonFlow.
 * Outbound messages ARE scanned via message_sending. See upstream issue
 * for async hook support.
 */

import { AxonFlowClient } from "./axonflow-client.js";
import { resolveConfig } from "./config.js";
import { createBeforeToolCallHandler } from "./governance.js";
import { createAfterToolCallHandler } from "./audit.js";
import { createMessageSendingHandler } from "./message-guard.js";
import { createLlmInputHandler, createLlmOutputHandler } from "./llm-audit.js";
import { sendTelemetryPing } from "./telemetry.js";
import { resetMetrics } from "./metrics.js";

/** Plugin version — update before each release. */
export const VERSION = "0.2.0";

// Re-export for external consumers
export { AxonFlowClient } from "./axonflow-client.js";
export type { AxonFlowPluginConfig } from "./config.js";
export { resolveConfig, shouldGovernTool } from "./config.js";
export { deriveConnectorType } from "./governance.js";
export { getMetrics, type GovernanceMetrics } from "./metrics.js";

/**
 * Plugin registration function.
 *
 * Called by OpenClaw when the plugin is loaded. Reads configuration,
 * creates the AxonFlow client, verifies connectivity, registers five
 * governance/audit hooks, and sends a telemetry ping.
 */
export function registerAxonFlowGovernance(api: {
  pluginConfig?: Record<string, unknown>;
  logger: { info: (msg: string) => void; error: (msg: string) => void; warn?: (msg: string) => void };
  on: (
    hookName: string,
    handler: (...args: any[]) => any,
    opts?: { priority?: number },
  ) => void;
}): void {
  const config = resolveConfig(api.pluginConfig);
  const client = new AxonFlowClient(config);

  // Reset metrics on each registration (handles hot-reload)
  resetMetrics();

  api.logger.info(
    `AxonFlow governance active: endpoint=${config.endpoint}, ` +
      `highRiskTools=[${(config.highRiskTools ?? []).join(",")}]`,
  );

  // Startup health check (fire-and-forget, non-blocking)
  void client.healthCheck().then((healthy) => {
    if (!healthy) {
      const msg = `AxonFlow health check failed: ${config.endpoint} is unreachable. Governance hooks will ${config.onError === "allow" ? "fail-open (allow through)" : "fail-closed (block)"}`;
      if (api.logger.warn) {
        api.logger.warn(msg);
      } else {
        api.logger.error(msg);
      }
    }
  }).catch(() => {
    // Silent — health check should never prevent plugin registration
  });

  // Hook 1: Input governance (before tool execution)
  const beforeToolCall = createBeforeToolCallHandler(client, config);
  api.on("before_tool_call", beforeToolCall, { priority: 10 });

  // Hook 2: Audit logging (after tool execution)
  const afterToolCall = createAfterToolCallHandler(client, config);
  api.on("after_tool_call", afterToolCall, { priority: 90 });

  // Hook 3: Outbound message governance (before message reaches user)
  const messageSending = createMessageSendingHandler(client, config);
  api.on("message_sending", messageSending, { priority: 10 });

  // Hook 4-5: LLM call audit (observe-only, cannot block/modify)
  const llmCallState = new Map<string, { provider: string; model: string; prompt: string; startMs: number }>();
  const llmInput = createLlmInputHandler(client, config, llmCallState);
  api.on("llm_input", llmInput, { priority: 90 });

  const llmOutput = createLlmOutputHandler(client, config, llmCallState);
  api.on("llm_output", llmOutput, { priority: 90 });

  // Telemetry (fire-and-forget, respects DO_NOT_TRACK=1)
  sendTelemetryPing({
    endpoint: config.endpoint,
    pluginVersion: VERSION,
    hookCount: 5,
    highRiskToolCount: (config.highRiskTools ?? []).length,
    onError: config.onError ?? "block",
  });
}

/**
 * Default export for OpenClaw plugin loader.
 *
 * OpenClaw expects extensions to export a default object with `id`, `name`,
 * and `register` function. This is the entry point when installed via
 * `openclaw plugins install @axonflow/openclaw`.
 */
export default {
  id: "axonflow-governance",
  name: "AxonFlow Governance",
  description: "Policy enforcement for tool inputs, PII scanning on outbound messages, and audit trails for OpenClaw",
  register: registerAxonFlowGovernance,
};
