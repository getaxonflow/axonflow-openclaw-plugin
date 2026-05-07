/**
 * Agent-callable tool registrations (W2: read-side governance surface).
 *
 * Wraps the AxonFlowClient read methods (search audit, explain decision,
 * list/create/revoke override) as OpenClaw `AgentTool`s so that an agent
 * running in OpenClaw can invoke them autonomously via tool-calling.
 *
 * Tools are registered through `api.registerTool(...)` in `index.ts`.
 * The runtime e2e test under `tests/e2e/runtime-tools-smoke.mjs`
 * exercises each tool via its `execute()` function — the same path
 * OpenClaw's tool dispatcher uses — against a live AxonFlow stack.
 *
 * Tool naming convention: `axonflow_<verb>_<object>` (e.g.
 * `axonflow_audit_search`). The prefix avoids name collisions with
 * other plugins or built-in tools.
 */

import type { ClientRef } from "./client-ref.js";
import { AxonFlowHttpError } from "./axonflow-client.js";

interface ToolContent {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolContent[];
  details: unknown;
  isError?: boolean;
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}

function asPolicyType(v: unknown): "static" | "dynamic" {
  if (v === "static" || v === "dynamic") return v;
  throw new Error(`policy_type must be "static" or "dynamic" (got ${JSON.stringify(v)})`);
}

function ok(payload: unknown): ToolResult {
  const text = JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }], details: payload };
}

function fail(message: string, details?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { error: message, ...(details ?? {}) },
    isError: true,
  };
}

function describeError(e: unknown): { message: string; details?: Record<string, unknown> } {
  if (e instanceof AxonFlowHttpError) {
    return {
      message: `HTTP ${e.status} ${e.statusText}`,
      details: { status: e.status, body: e.responseBody },
    };
  }
  if (e instanceof Error) return { message: e.message };
  return { message: "Unknown error" };
}

/**
 * Tool definition matching OpenClaw's `AnyAgentTool` shape (subset used
 * by plugin-registered tools — name, label, description, parameters,
 * execute). Typed loosely here to avoid pulling typebox into the plugin
 * just for parameter schemas — OpenClaw accepts plain JSON Schema
 * objects on the parameters field.
 */
export interface AgentToolDef {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

// ─── audit_search ──────────────────────────────────────────────────────

export function buildAuditSearchTool(clientRef: ClientRef): AgentToolDef {
  return {
    name: "axonflow_audit_search",
    label: "AxonFlow: Search Audit Trail",
    description:
      "Search AxonFlow's audit trail for recent tool executions, policy decisions, and PII detections. " +
      "Use this to answer 'what happened recently', 'which tools got blocked', or to gather compliance evidence. " +
      "Defaults to the last hour. Returns up to 100 entries.",
    parameters: {
      type: "object",
      properties: {
        start_time: {
          type: "string",
          description: "ISO 8601 start of the search window. Defaults to one hour ago.",
        },
        end_time: {
          type: "string",
          description: "ISO 8601 end of the search window. Defaults to now.",
        },
        request_type: {
          type: "string",
          description: "Filter by request_type (e.g. tool_call_audit, llm_call).",
        },
        limit: {
          type: "number",
          description: "Maximum entries to return (1-100, default 20).",
          minimum: 1,
          maximum: 100,
        },
      },
      additionalProperties: false,
    },
    execute: async (_id, args) => {
      try {
        // Strict variant — throws on transport / non-2xx so a platform
        // outage or auth failure does not silently look like "no audit
        // events" to the calling agent.
        const result = await clientRef.current.searchAuditEventsStrict({
          startTime: readString(args, "start_time"),
          endTime: readString(args, "end_time"),
          requestType: readString(args, "request_type"),
          limit: readNumber(args, "limit"),
        });
        return ok(result);
      } catch (e) {
        const { message, details } = describeError(e);
        return fail(message, details);
      }
    },
  };
}

// ─── explain_decision ──────────────────────────────────────────────────

export function buildExplainDecisionTool(clientRef: ClientRef): AgentToolDef {
  return {
    name: "axonflow_explain_decision",
    label: "AxonFlow: Explain Policy Decision",
    description:
      "Fetch the full explanation for a previously-made policy decision (allow or deny). " +
      "Returns matched policies, risk level, decision reason, override availability, and a rolling 24h hit count. " +
      "Use this when an agent or user asks 'why was this blocked?' or wants context before requesting an override.",
    parameters: {
      type: "object",
      properties: {
        decision_id: {
          type: "string",
          description: "Decision identifier surfaced in the original policy-check response.",
        },
      },
      required: ["decision_id"],
      additionalProperties: false,
    },
    execute: async (_id, args) => {
      const decisionId = readString(args, "decision_id");
      if (!decisionId) return fail("decision_id is required");
      try {
        // Strict variant distinguishes 404 (decision genuinely not found)
        // from any other non-2xx (transport / auth / 5xx). Without this
        // the agent could see the same null on both paths and report
        // "no explanation available" during a platform outage.
        const result = await clientRef.current.explainDecisionStrict(decisionId);
        if (result.kind === "not_found") {
          return fail(`No explanation found for decision_id=${decisionId}`, {
            decision_id: decisionId,
            not_found: true,
          });
        }
        return ok(result.explanation);
      } catch (e) {
        const { message, details } = describeError(e);
        return fail(message, details);
      }
    },
  };
}

// ─── list_overrides ────────────────────────────────────────────────────

export function buildListOverridesTool(clientRef: ClientRef): AgentToolDef {
  return {
    name: "axonflow_list_overrides",
    label: "AxonFlow: List Active Overrides",
    description:
      "List session overrides scoped to the caller's tenant. " +
      "Use this to audit dangling overrides before tearing them down, or to confirm an override is active before retrying a previously-blocked tool call.",
    parameters: {
      type: "object",
      properties: {
        policy_id: {
          type: "string",
          description: "Filter to overrides for a specific policy.",
        },
        include_revoked: {
          type: "boolean",
          description: "Include already-revoked overrides in results. Default false.",
        },
      },
      additionalProperties: false,
    },
    execute: async (_id, args) => {
      try {
        // Strict variant — throws on transport / non-2xx so a platform
        // outage does not silently look like "no overrides exist" to
        // the calling agent.
        const result = await clientRef.current.listOverridesStrict({
          policyId: readString(args, "policy_id"),
          includeRevoked: readBoolean(args, "include_revoked"),
        });
        return ok(result);
      } catch (e) {
        const { message, details } = describeError(e);
        return fail(message, details);
      }
    },
  };
}

// ─── create_override ───────────────────────────────────────────────────

export function buildCreateOverrideTool(clientRef: ClientRef): AgentToolDef {
  return {
    name: "axonflow_create_override",
    label: "AxonFlow: Create Session Override",
    description:
      "Create a governed session override for a policy that would otherwise deny. " +
      "Mandatory free-text justification; TTL clamped server-side (default 60m, hard cap 24h). " +
      "Critical-risk policies and policies with allow_override=false are rejected (403).",
    parameters: {
      type: "object",
      properties: {
        policy_id: { type: "string", description: "Policy to override." },
        policy_type: {
          type: "string",
          enum: ["static", "dynamic"],
          description: "Policy registry type.",
        },
        override_reason: {
          type: "string",
          description: "Mandatory justification (1-500 chars).",
        },
        tool_signature: {
          type: "string",
          description: "Optional: restrict override to a specific tool name.",
        },
        ttl_seconds: {
          type: "number",
          description: "Requested TTL in seconds. Server clamps to [60, 86400] (default 3600).",
          minimum: 60,
          maximum: 86400,
        },
      },
      required: ["policy_id", "policy_type", "override_reason"],
      additionalProperties: false,
    },
    execute: async (_id, args) => {
      const policyId = readString(args, "policy_id");
      const overrideReason = readString(args, "override_reason");
      if (!policyId) return fail("policy_id is required");
      if (!overrideReason) return fail("override_reason is required");
      let policyType: "static" | "dynamic";
      try {
        policyType = asPolicyType(args["policy_type"]);
      } catch (e) {
        return fail(e instanceof Error ? e.message : "invalid policy_type");
      }
      try {
        const result = await clientRef.current.createOverride({
          policyId,
          policyType,
          overrideReason,
          toolSignature: readString(args, "tool_signature"),
          ttlSeconds: readNumber(args, "ttl_seconds"),
        });
        return ok(result);
      } catch (e) {
        const { message, details } = describeError(e);
        return fail(message, details);
      }
    },
  };
}

// ─── revoke_override ───────────────────────────────────────────────────

export function buildRevokeOverrideTool(clientRef: ClientRef): AgentToolDef {
  return {
    name: "axonflow_revoke_override",
    label: "AxonFlow: Revoke Session Override",
    description:
      "Revoke an active session override. The next policy evaluation after revocation will not consult this override. Emits an override_revoked audit event.",
    parameters: {
      type: "object",
      properties: {
        override_id: {
          type: "string",
          description: "Override ID returned by axonflow_create_override.",
        },
      },
      required: ["override_id"],
      additionalProperties: false,
    },
    execute: async (_id, args) => {
      const overrideId = readString(args, "override_id");
      if (!overrideId) return fail("override_id is required");
      try {
        await clientRef.current.revokeOverride(overrideId);
        return ok({ override_id: overrideId, revoked: true });
      } catch (e) {
        const { message, details } = describeError(e);
        return fail(message, details);
      }
    },
  };
}

// ─── axonflow_get_tenant_id ────────────────────────────────────────────
//
// Cross-plugin parity tool (S3 lane of axonflow-enterprise#1958). The
// other three plugin hosts (claude-code / cursor / codex) consume this
// from the agent's MCP server via auto-discovery. OpenClaw doesn't
// proxy that MCP server, so we register a local equivalent that builds
// the same shape from the resolved plugin config — tenant_id, the
// caller's tier (resolved from the locally-loaded license token, same
// shape `buildStatusReport` already emits), and the locked V1 upgrade
// URLs. Keeps cross-plugin behaviour consistent: any host that has the
// AxonFlow plugin loaded can answer "what's my tenant ID?" inline
// without spawning a shell.

export function buildGetTenantIdTool(): AgentToolDef {
  return {
    name: "axonflow_get_tenant_id",
    label: "AxonFlow: Get Tenant ID + Tier",
    description:
      "Return this AxonFlow plugin install's tenant_id, current tier (Free / Pro / pro_expired), " +
      "and the canonical upgrade URLs. Use when the user asks how to upgrade, what tier they're on, " +
      "or for the tenant_id they need to paste into Stripe Checkout. Available in every tier.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      // Lazy import keeps the tool table cheap to build at registration
      // time — the status module pulls in fs + path which we don't want
      // to run unless the tool is actually invoked.
      const { buildStatusReport, resolveStatusInputs } = await import("./status.js");
      try {
        const inputs = resolveStatusInputs();
        const report = buildStatusReport(inputs);
        return ok({
          tenant_id: report.tenant_id,
          tier: report.tier,
          endpoint: report.endpoint,
          upgrade_url: report.upgrade_url,
          // Locked V1 buy URL — duplicates community_saas_ratelimit_response.go's
          // v1ProUpgradeBuyURL constant. Tracked in the cross-surface drift
          // checklist (feedback_cross_surface_drift_check_categorized.md):
          // any change to the buy URL needs a matching update in:
          //   - axonflow-enterprise/platform/agent/community_saas_ratelimit_response.go
          //   - axonflow-enterprise/platform/agent/billing/email.go
          //   - axonflow-landing/content/pricing.html (hardcoded button href)
          //   - the 4 plugin repos' upgrade-prompt helpers + status surfaces.
          buy_url: "https://buy.stripe.com/bJe28qbztcdVchjdkw8k800",
          expires_at: report.expires_at,
          expires_in_days: report.expires_in_days,
        });
      } catch (e) {
        const { message, details } = describeError(e);
        return fail(message, details);
      }
    },
  };
}

// ─── V1 Plugin Pro proxy tools (4) ─────────────────────────────────────
//
// Cross-plugin parity: claude / cursor / codex auto-discover these from
// the agent's MCP server `/api/v1/mcp-server` `tools/list`. OpenClaw
// doesn't proxy that MCP server today, so each of the 4 tools is
// registered locally as an AgentToolDef whose `execute()` forwards to
// the agent via `clientRef.current.callMCPTool(name, args)`.
//
// V1 Plugin Pro envelope handling: when a Free-tier caller hits a
// graduated cap (active_policies, hitl_approvals_window) or a Pro-only
// gate (feature_pro_only on get_cost_estimate), the agent emits the
// locked V1 envelope shape. callMCPTool detects the envelope inside
// the JSON-RPC `result.content[0].text` payload, surfaces the upgrade
// prompt via the host plugin logger (gated to once-per-UTC-day), and
// stamps the throttle file. The proxy tool returns the wording back
// to the agent as a plain `fail(...)` so the agent can render it.
//
// Schemas mirror the locked definitions in
// `axonflow-enterprise/platform/agent/mcp_v1_pro_tools.go` —
// drift-tracked: any change to the agent-side schemas needs a
// matching update here.

function describeMCPCallResult<T>(
  res:
    | { kind: "ok"; result: unknown }
    | { kind: "envelope"; envelope: import("./upgrade-prompt.js").V1RateLimitEnvelope }
    | { kind: "throttled" }
    | { kind: "error"; message: string; status?: number },
  successKey: T,
): ToolResult {
  void successKey; // present in the type for future use; intentionally unused at runtime
  if (res.kind === "ok") {
    return ok(res.result);
  }
  if (res.kind === "envelope") {
    const env = res.envelope;
    const wording = env.upgrade?.wording || env.error || "Free-tier limit reached";
    return fail(wording, {
      limit_type: env.limit_type,
      tier: env.tier,
      limit: env.limit,
      remaining: env.remaining,
      window: env.window,
      resets_at: env.resets_at,
      upgrade_url: env.upgrade?.compare_url,
      buy_url: env.upgrade?.buy_url,
    });
  }
  if (res.kind === "throttled") {
    return fail(
      "AxonFlow Free-tier cap is active — back-off in effect from a previous V1 envelope. Try again after the deadline.",
      { throttled: true },
    );
  }
  return fail(res.message, res.status !== undefined ? { status: res.status } : undefined);
}

export function buildRequestApprovalTool(clientRef: ClientRef): AgentToolDef {
  return {
    name: "axonflow_request_approval",
    label: "AxonFlow: Request HITL Approval",
    description:
      "Request human-in-the-loop approval before executing a risky operation (e.g. shell command, file write, git push). " +
      "On Free tier, 1 approval request allowed per rolling 7-day window. On Pro, unlimited.",
    parameters: {
      type: "object",
      properties: {
        original_query: {
          type: "string",
          description: "The user's original natural-language request that prompted this approval check.",
        },
        request_type: {
          type: "string",
          description: "Category of the operation requiring approval (e.g. 'shell_command', 'file_write', 'git_push').",
        },
        trigger_reason: {
          type: "string",
          description: "Why approval is being requested (e.g. 'destructive_command', 'production_deploy').",
        },
        severity: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          description: "Risk severity of the operation.",
        },
      },
      required: ["original_query", "request_type"],
      additionalProperties: false,
    },
    execute: async (_id, args) => {
      try {
        const res = await clientRef.current.callMCPTool("axonflow_request_approval", args);
        return describeMCPCallResult(res, "approval");
      } catch (e) {
        const { message, details } = describeError(e);
        return fail(message, details);
      }
    },
  };
}

export function buildCreateTenantPolicyTool(clientRef: ClientRef): AgentToolDef {
  return {
    name: "axonflow_create_tenant_policy",
    label: "AxonFlow: Create Tenant Policy",
    description:
      "Create a custom tenant-scoped governance policy. Free tier supports 2 active policies (delete one to make room); " +
      "Pro removes the cap. Useful for rules like 'block writes to ~/.ssh/' or 'require approval for any rm -rf'.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable policy name." },
        description: { type: "string", description: "What the policy does." },
        connector_type: {
          type: "string",
          description: "Tool / connector this policy applies to (e.g. 'openclaw.Bash', '*' for all).",
        },
        pattern: {
          type: "string",
          description: "Regex or literal pattern to match against tool inputs.",
        },
        action: {
          type: "string",
          enum: ["block", "warn", "audit", "require_approval"],
          description: "Action to take on match.",
        },
      },
      required: ["name", "connector_type", "pattern", "action"],
      additionalProperties: false,
    },
    execute: async (_id, args) => {
      try {
        const res = await clientRef.current.callMCPTool("axonflow_create_tenant_policy", args);
        return describeMCPCallResult(res, "policy");
      } catch (e) {
        const { message, details } = describeError(e);
        return fail(message, details);
      }
    },
  };
}

export function buildGetCostEstimateTool(clientRef: ClientRef): AgentToolDef {
  return {
    name: "axonflow_get_cost_estimate",
    label: "AxonFlow: LLM Cost Pre-Flight Estimate",
    description:
      "Estimate the LLM token cost of a planned multi-step operation BEFORE running it. " +
      "Pro-tier feature — the tool will return a Pro-only envelope on Free tier. Returns input/output token estimates, total cost in USD.",
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description: "Description of the multi-step operation to cost-estimate.",
        },
        model: {
          type: "string",
          description: "LLM model identifier (e.g. 'claude-opus-4-7', 'gpt-4'). Defaults to the agent's default model.",
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
    execute: async (_id, args) => {
      try {
        const res = await clientRef.current.callMCPTool("axonflow_get_cost_estimate", args);
        return describeMCPCallResult(res, "estimate");
      } catch (e) {
        const { message, details } = describeError(e);
        return fail(message, details);
      }
    },
  };
}

export function buildListProFeaturesTool(clientRef: ClientRef): AgentToolDef {
  return {
    name: "axonflow_list_pro_features",
    label: "AxonFlow: List Pro Features",
    description:
      "Return the locked V1 Plugin Pro feature list as data. Use when the user asks 'what would I get if I upgraded?'. Available in all tiers.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_id, args) => {
      try {
        const res = await clientRef.current.callMCPTool("axonflow_list_pro_features", args);
        return describeMCPCallResult(res, "features");
      } catch (e) {
        const { message, details } = describeError(e);
        return fail(message, details);
      }
    },
  };
}

/**
 * Build the full set of agent-callable tools. Order is irrelevant — the
 * registration order is preserved by OpenClaw but tool dispatch is by
 * name lookup, not array position.
 */
export function buildAgentTools(clientRef: ClientRef): AgentToolDef[] {
  return [
    buildAuditSearchTool(clientRef),
    buildExplainDecisionTool(clientRef),
    buildListOverridesTool(clientRef),
    buildCreateOverrideTool(clientRef),
    buildRevokeOverrideTool(clientRef),
    buildGetTenantIdTool(),
    buildRequestApprovalTool(clientRef),
    buildCreateTenantPolicyTool(clientRef),
    buildGetCostEstimateTool(clientRef),
    buildListProFeaturesTool(clientRef),
  ];
}
