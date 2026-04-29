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

import * as fs from "fs";
import * as path from "path";
import { AxonFlowClient } from "./axonflow-client.js";
import { axonflowCacheDir } from "./cache-dir.js";
import type { ClientRef } from "./client-ref.js";
import { resolveConfig } from "./config.js";
import { createBeforeToolCallHandler } from "./governance.js";
import { createAfterToolCallHandler } from "./audit.js";
import { createMessageSendingHandler } from "./message-guard.js";
import { createLlmInputHandler, createLlmOutputHandler } from "./llm-audit.js";
import { sendTelemetryPing } from "./telemetry.js";
import { bootstrapCommunitySaas } from "./community-saas-bootstrap.js";
import { resetMetrics } from "./metrics.js";

/** Plugin version — update before each release. */
export const VERSION = "1.4.0";

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

  // Reset metrics on each registration (handles hot-reload)
  resetMetrics();

  // Mode-clarity canary — emitted on every plugin init so users always know
  // which AxonFlow they're connected to. The Gate 4 mode-clarity test
  // (tests/mode-clarity.test.ts) parses this exact line and asserts
  // URL + mode match the resolved config.
  api.logger.info(
    `[AxonFlow] Connected to AxonFlow at ${config.endpoint} (mode=${config.mode})`,
  );

  // In community-saas mode, register asynchronously against try.getaxonflow.com
  // and override the client credentials with the bootstrapped values once
  // they arrive. The startup health check + the first hook fire happen
  // immediately; if the bootstrap is still pending when a hook fires, the
  // existing AxonFlowClient handles the (transient) 401 and retries with
  // the new credentials on the next call once they're loaded.
  // Mutable holder so the bootstrap reassignment below is visible to every
  // hook factory we register. Hook factories close over `clientRef` and read
  // `clientRef.current.<method>(...)` so swapping in a freshly-credentialled
  // client after the async bootstrap completes propagates immediately.
  // Without this indirection the bootstrap would silently no-op for hooks
  // (they'd keep using the empty-credential client they were registered with).
  const clientRef: ClientRef = { current: new AxonFlowClient(config) };
  if (config.mode === "community-saas") {
    void bootstrapCommunitySaas({
      endpoint: config.endpoint,
      pluginVersion: VERSION,
    }).then((result) => {
      if (!result || result.source === "failed" || result.source === "rate-limited") {
        const detail = result?.source === "rate-limited"
          ? "rate-limited (will retry)"
          : "failed (network error or non-2xx response)";
        const msg = `AxonFlow Community SaaS registration ${detail}. Tool calls will fail-${config.onError === "allow" ? "open (allow through)" : "closed (block)"} until registration succeeds.`;
        if (api.logger.warn) {
          api.logger.warn(msg);
        } else {
          api.logger.error(msg);
        }
        return;
      }
      const enriched = {
        ...config,
        endpoint: result.endpoint,
        clientId: result.clientId,
        clientSecret: result.clientSecret,
      };
      clientRef.current = new AxonFlowClient(enriched);
      api.logger.info(
        `[AxonFlow] Community SaaS registration ${result.source === "fresh-registration" ? "complete" : "loaded from cache"} (tenant=${result.clientId.slice(0, 16)}...)`,
      );
    }).catch(() => {
      // Silent — bootstrap should never block plugin registration. The
      // governance handlers will fail-open or fail-closed per onError config.
    });
  }

  // One-time positive disclosure on first Community-SaaS connection.
  // Stamped at axonflowCacheDir()/openclaw-plugin-disclosure-shown so it
  // fires exactly once per install (separate stamp from the heartbeat).
  if (config.mode === "community-saas") {
    showCommunitySaasDisclosureOnce(api);
  }

  // Startup health check (fire-and-forget, non-blocking)
  void clientRef.current.healthCheck().then((healthy) => {
    if (healthy) {
      api.logger.info(`AxonFlow connected: ${config.endpoint}`);
    } else {
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
  const beforeToolCall = createBeforeToolCallHandler(clientRef, config);
  api.on("before_tool_call", beforeToolCall, { priority: 10 });

  // Hook 2: Audit logging (after tool execution)
  const afterToolCall = createAfterToolCallHandler(clientRef, config);
  api.on("after_tool_call", afterToolCall, { priority: 90 });

  // Hook 3: Outbound message governance (before message reaches user)
  const messageSending = createMessageSendingHandler(clientRef, config);
  api.on("message_sending", messageSending, { priority: 10 });

  // Hook 4-5: LLM call audit (observe-only, cannot block/modify)
  const llmCallState = new Map<string, { provider: string; model: string; prompt: string; startMs: number }>();
  const llmInput = createLlmInputHandler(clientRef, config, llmCallState);
  api.on("llm_input", llmInput, { priority: 90 });

  const llmOutput = createLlmOutputHandler(clientRef, config, llmCallState);
  api.on("llm_output", llmOutput, { priority: 90 });

  // Telemetry — 7-day heartbeat (fire-and-forget; opt out with
  // AXONFLOW_TELEMETRY=off). The promise is intentionally not awaited.
  void sendTelemetryPing({
    endpoint: config.endpoint,
    pluginVersion: VERSION,
    hookCount: 5,
    highRiskToolCount: (config.highRiskTools ?? []).length,
    onError: config.onError ?? "block",
    mode: config.mode,
  });
}

/**
 * One-time positive disclosure when first connecting to Community SaaS.
 * Stamped at axonflowCacheDir()/openclaw-plugin-disclosure-shown so it
 * fires exactly once per install. Failures (no writable cache dir, etc.)
 * fall through silently — the disclosure is best-effort and never blocks
 * plugin registration.
 */
function showCommunitySaasDisclosureOnce(api: {
  logger: { info: (msg: string) => void };
}): void {
  const cacheDir = axonflowCacheDir();
  if (!cacheDir) return;
  const stamp = path.join(cacheDir, "openclaw-plugin-disclosure-shown");
  try {
    fs.statSync(stamp);
    return; // already shown
  } catch {
    // not stamped yet — proceed
  }
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }
  api.logger.info(
    "[AxonFlow] Connected to AxonFlow Community SaaS at https://try.getaxonflow.com.\n" +
    "Intended for basic testing and evaluation. For real workflows, real systems,\n" +
    "or sensitive data, we recommend self-hosting AxonFlow from day one:\n" +
    "  https://docs.getaxonflow.com/quickstart\n" +
    "Anonymous telemetry: weekly heartbeat. Opt out: AXONFLOW_TELEMETRY=off",
  );
  try {
    fs.writeFileSync(stamp, "", { mode: 0o600 });
  } catch {
    // best effort; if we can't stamp, the message will fire again
    // next time. Acceptable trade-off vs not surfacing it.
  }
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
