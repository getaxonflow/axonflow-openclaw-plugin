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
        const result = await clientRef.current.searchAuditEvents({
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
        const explanation = await clientRef.current.explainDecision(decisionId);
        if (!explanation) {
          return fail(`No explanation available for decision_id=${decisionId}`, {
            decision_id: decisionId,
          });
        }
        return ok(explanation);
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
        const result = await clientRef.current.listOverrides({
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
  ];
}
