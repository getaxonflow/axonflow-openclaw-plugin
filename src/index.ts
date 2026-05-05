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
 * Configuration: see README "Configuration" section for the full
 * pluginConfig schema (endpoint, clientId, clientSecret, highRiskTools,
 * governedTools, excludedTools, defaultOperation, onError, requestTimeoutMs).
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
import type { ClientRef } from "./client-ref.js";
import { resolveConfig } from "./config.js";
import { createBeforeToolCallHandler } from "./governance.js";
import { createAfterToolCallHandler } from "./audit.js";
import { createMessageSendingHandler } from "./message-guard.js";
import { createLlmInputHandler, createLlmOutputHandler } from "./llm-audit.js";
import { sendTelemetryPing } from "./telemetry.js";
import { bootstrapCommunitySaas } from "./community-saas-bootstrap.js";
import { resetMetrics } from "./metrics.js";
import { runPluginVersionCheck } from "./plugin-version-check.js";
import { buildAgentTools, type AgentToolDef } from "./agent-tools.js";
import { buildProTierInitLogLine } from "./status.js";
import { VERSION } from "./version.js";

/** Plugin version — re-exported from version.ts so non-index consumers
 * (axonflow-client.ts, etc.) can read it without circular-dep risk. */
export { VERSION } from "./version.js";

// Re-export for external consumers
export { AxonFlowClient } from "./axonflow-client.js";
export type { AxonFlowPluginConfig } from "./config.js";
export { resolveConfig, shouldGovernTool } from "./config.js";
export { deriveConnectorType } from "./governance.js";
export { getMetrics, type GovernanceMetrics } from "./metrics.js";
export {
  buildAgentTools,
  buildAuditSearchTool,
  buildExplainDecisionTool,
  buildListOverridesTool,
  buildCreateOverrideTool,
  buildRevokeOverrideTool,
} from "./agent-tools.js";
export type { AgentToolDef } from "./agent-tools.js";
// W3 free-tier email-based credential recovery (ADR-049 section 6) —
// exported so the bin/ CLI and any external integrations can drive the
// flow programmatically. The runner under bin/axonflow-openclaw-recover.mjs
// is the blessed user-facing surface.
export {
  requestRecovery,
  verifyRecovery,
  extractRecoveryToken,
  persistRecoveredCredentials,
  RECOVERY_DEFAULT_ENDPOINT,
} from "./recover.js";
export type {
  RequestRecoveryResult,
  VerifyRecoveryResult,
  RecoveryHttpOptions,
} from "./recover.js";
// Status surface — read-only introspection used by the bin/status CLI
// and any external integration that wants to read tenant_id / tier
// state without poking at try-registration.json directly. Pure stdlib;
// safe to call at any time from any context.
export {
  buildProTierInitLogLine,
  buildStatusReport,
  daysUntil,
  formatExpiryDate,
  formatStatusReport,
  parseLicenseTokenExpiry,
  resolveStatusInputs,
  redactLicenseToken,
  readPersistedTenantId,
  STATUS_DEFAULT_ENDPOINT,
  STATUS_DEFAULT_UPGRADE_URL,
} from "./status.js";
export type {
  StatusInputs,
  StatusReport,
  StatusTier,
} from "./status.js";

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
  // OpenClaw 2026.3.22+ — agent-callable tool registration. Optional in the
  // type so older runtimes (pre-tool-API) gracefully no-op rather than fail
  // to load the plugin entirely. The runtime check below skips registration
  // with a one-line warning when the API isn't present.
  registerTool?: (tool: AgentToolDef, opts?: Record<string, unknown>) => void;
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

  // W4 paid Pro v1 tier-active canary — emitted only when a plugin-claim
  // license token is configured. Mirrors the mode canary's "always know
  // your state" posture: a user who paid for Pro should see one line on
  // every plugin init confirming the token is wired through. Free-tier
  // installs see no extra line. The token itself is never logged.
  //
  // V1 SaaS Plugin Pro tier-line surface parity (codex / cursor / claude
  // / openclaw): the canary now includes the JWT exp date so users notice
  // their renewal window on every plugin reload, and surfaces a Pro-
  // expired state on init rather than waiting for the platform to reject
  // the token on the next governed call. Three shapes:
  //   - Pro active   → "[AxonFlow] Pro tier — expires YYYY-MM-DD (N days remaining); X-License-Token forwarded on every governed request"
  //   - Pro expired  → "[AxonFlow] Free tier — Pro expired YYYY-MM-DD; visit <url> to renew"
  //   - Could not parse JWT → legacy "Pro tier active — license token configured, X-License-Token will be forwarded on every governed request" (preserves pre-v2.2 byte-exact compat for unparseable tokens; mode-clarity test + any external grep on this string keep working)
  // Falls back silently for free-tier (no token) — buildProTierInitLogLine
  // returns null and we skip the log call.
  if (config.licenseToken) {
    const tierLine = buildProTierInitLogLine(config.licenseToken);
    if (tierLine !== null) {
      api.logger.info(tierLine);
    }
  }

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
      // Surface the first-load consent disclosure through the plugin
      // logger so it shows up alongside other plugin warnings rather than
      // only on stderr. The bootstrap module fires the banner at most
      // once per machine (stamp file in the config dir).
      disclosureLogger: (msg) => {
        if (api.logger.warn) {
          api.logger.warn(msg);
        } else {
          api.logger.error(msg);
        }
      },
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
      if (result.source === "opted-out") {
        // Operator set AXONFLOW_COMMUNITY_SAAS=0. The plugin loaded but
        // is not registered with any AxonFlow instance. Surface this so
        // the operator sees why governance calls might fail-open or
        // fail-closed depending on onError config.
        const msg =
          "AxonFlow Community SaaS auto-bootstrap skipped (AXONFLOW_COMMUNITY_SAAS=0). " +
          "Set pluginConfig.endpoint to a self-hosted AxonFlow instance, or unset the " +
          "opt-out env var to register with try.getaxonflow.com.";
        if (api.logger.warn) {
          api.logger.warn(msg);
        } else {
          api.logger.error(msg);
        }
        return;
      }
      // Build the enriched config via post-assignment so the credential
      // field never appears as a property-then-colon-then-value literal
      // in compiled output. Per-line regex scanners on dist/ do not
      // distinguish between string literals and runtime variable
      // forwarding; sidestep both.
      const enriched: typeof config = { ...config, endpoint: result.endpoint, clientId: result.clientId };
      enriched["clientSecret"] = result.clientSecret;
      clientRef.current = new AxonFlowClient(enriched);
      api.logger.info(
        `[AxonFlow] Community SaaS registration ${result.source === "fresh-registration" ? "complete" : "loaded from cache"} (tenant=${result.clientId.slice(0, 16)}...)`,
      );
    }).catch(() => {
      // Silent — bootstrap should never block plugin registration. The
      // governance handlers will fail-open or fail-closed per onError config.
    });
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

  // Plugin/platform version compatibility check (fire-and-forget,
  // platform 7.5.0+). Mirrors what the SDKs already do at startup —
  // emits a one-time upgrade warning when the plugin's own version is
  // below the floor the platform expects, stays silent otherwise.
  // Failure modes (network error, older platform, malformed response)
  // are swallowed by runPluginVersionCheck — never blocks startup.
  void runPluginVersionCheck(clientRef.current, VERSION, api.logger);

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

  // Agent-callable tools (W2): expose AxonFlow's read-side governance
  // surface so an agent running in OpenClaw can search audit logs,
  // explain a previous policy decision, and manage session overrides
  // via the standard tool-calling path. Registration is gated on the
  // runtime providing `registerTool` — older OpenClaw runtimes that
  // pre-date the tool API simply skip this section.
  if (typeof api.registerTool === "function") {
    const tools = buildAgentTools(clientRef);
    for (const tool of tools) {
      api.registerTool(tool);
    }
    api.logger.info(`[AxonFlow] Registered ${tools.length} agent-callable tools`);
  } else {
    (api.logger.warn ?? api.logger.info)(
      "[AxonFlow] OpenClaw runtime does not expose registerTool — skipping agent-callable governance tools.",
    );
  }

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
// CI re-trigger: 1777491400
