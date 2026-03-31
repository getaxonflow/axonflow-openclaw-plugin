/**
 * AxonFlow Governance Plugin for OpenClaw
 *
 * Adds centralized policy enforcement, PII detection, and audit trails
 * to OpenClaw tool execution. Works with all OpenClaw tools: built-in,
 * plugin-provided, and MCP-backed.
 *
 * Install:
 *   openclaw plugins install @axonflow/openclaw-plugin
 *
 * Configure in your OpenClaw config:
 *   plugins:
 *     @axonflow/openclaw-plugin:
 *       endpoint: http://localhost:8080
 *       clientId: your-client-id
 *       clientSecret: your-secret
 *       highRiskTools:
 *         - web_fetch
 *         - message
 *
 * What this plugin does:
 * 1. before_tool_call: evaluates tool arguments against AxonFlow policies
 *    (blocks dangerous commands, detects PII, enforces rate limits)
 * 2. tool_result_persist: scans tool results for PII/secrets and redacts
 *    before they reach the session transcript
 * 3. after_tool_call: logs every tool execution to AxonFlow's audit trail
 */

import { AxonFlowClient } from "./axonflow-client.js";
import { resolveConfig } from "./config.js";
import { createBeforeToolCallHandler } from "./governance.js";
import { createOutputGuardHandler } from "./output-guard.js";
import { createAfterToolCallHandler } from "./audit.js";

// Re-export for external consumers
export { AxonFlowClient } from "./axonflow-client.js";
export type { AxonFlowPluginConfig } from "./config.js";
export { resolveConfig, shouldGovernTool } from "./config.js";
export { deriveConnectorType } from "./governance.js";
export { extractTextContent } from "./output-guard.js";

/**
 * Plugin registration function.
 *
 * Called by OpenClaw when the plugin is loaded. Reads configuration,
 * creates the AxonFlow client, and registers the three governance hooks.
 *
 * Compatible with OpenClaw's `definePluginEntry` or direct registration:
 *
 *   // With definePluginEntry:
 *   export default definePluginEntry({
 *     id: "axonflow-governance",
 *     register: registerAxonFlowGovernance,
 *   });
 *
 *   // Or direct:
 *   api.registerHook("before_tool_call", handler);
 */
export function registerAxonFlowGovernance(api: {
  pluginConfig?: Record<string, unknown>;
  logger: { info: (msg: string) => void; error: (msg: string) => void };
  registerHook: (
    events: string | string[],
    handler: (...args: any[]) => any,
    opts?: { priority?: number },
  ) => void;
}): void {
  const config = resolveConfig(api.pluginConfig);
  const client = new AxonFlowClient(config);

  api.logger.info(
    `AxonFlow governance active: endpoint=${config.endpoint}, ` +
      `highRiskTools=[${(config.highRiskTools ?? []).join(",")}]`,
  );

  // Hook 1: Input governance (before tool execution)
  const beforeToolCall = createBeforeToolCallHandler(client, config);
  api.registerHook("before_tool_call", beforeToolCall, { priority: 10 });

  // Hook 2: Output governance (before result persistence)
  const outputGuard = createOutputGuardHandler(client, config);
  api.registerHook("tool_result_persist", outputGuard, { priority: 10 });

  // Hook 3: Audit logging (after tool execution)
  const afterToolCall = createAfterToolCallHandler(client, config);
  api.registerHook("after_tool_call", afterToolCall, { priority: 90 });
}
