/**
 * Unit tests for the agent-callable tool definitions registered with
 * OpenClaw via `api.registerTool` (W2: read-side governance surface).
 *
 * Tests exercise each tool's `execute()` end-to-end against a stubbed
 * AxonFlowClient so we cover happy path, validation rejections, and
 * the AxonFlowHttpError surfacing path. Runtime e2e (against a live
 * stack) is in tests/e2e/runtime-tools-smoke.mjs.
 */

import {
  buildAgentTools,
  buildAuditSearchTool,
  buildExplainDecisionTool,
  buildListOverridesTool,
  buildCreateOverrideTool,
  buildRevokeOverrideTool,
} from "../src/agent-tools.js";
import { AxonFlowClient, AxonFlowHttpError } from "../src/axonflow-client.js";
import type { ClientRef } from "../src/client-ref.js";

function makeClientRef(): ClientRef {
  // Use a real client only for type compatibility — every method is
  // stubbed below per-test.
  const client = new AxonFlowClient({
    endpoint: "http://localhost:8080",
    clientId: "test",
    clientSecret: "secret",
    mode: "self-hosted",
  });
  return { current: client };
}

describe("agent-tools — buildAgentTools", () => {
  it("returns 10 tools with axonflow_ prefixed names (5 W2 governance + V1 Pro proxies)", () => {
    const ref = makeClientRef();
    const tools = buildAgentTools(ref);
    expect(tools).toHaveLength(10);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "axonflow_audit_search",
      "axonflow_create_override",
      "axonflow_create_tenant_policy",
      "axonflow_explain_decision",
      "axonflow_get_cost_estimate",
      "axonflow_get_tenant_id",
      "axonflow_list_overrides",
      "axonflow_list_pro_features",
      "axonflow_request_approval",
      "axonflow_revoke_override",
    ]);
  });

  it("each tool exposes label, description, parameters object, and execute", () => {
    const ref = makeClientRef();
    for (const tool of buildAgentTools(ref)) {
      expect(typeof tool.label).toBe("string");
      expect(tool.label.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toMatchObject({ type: "object" });
      expect(typeof tool.execute).toBe("function");
    }
  });
});

describe("axonflow_audit_search", () => {
  it("forwards mapped args to client.searchAuditEvents", async () => {
    const ref = makeClientRef();
    const spy = jest
      .spyOn(ref.current, "searchAuditEventsStrict")
      .mockResolvedValue({ entries: [{ id: "evt-1" }], total: 1 });

    const tool = buildAuditSearchTool(ref);
    const result = await tool.execute("call-1", {
      start_time: "2026-05-01T00:00:00Z",
      end_time: "2026-05-02T00:00:00Z",
      request_type: "tool_call_audit",
      limit: 50,
    });

    expect(spy).toHaveBeenCalledWith({
      startTime: "2026-05-01T00:00:00Z",
      endTime: "2026-05-02T00:00:00Z",
      requestType: "tool_call_audit",
      limit: 50,
    });
    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual({ entries: [{ id: "evt-1" }], total: 1 });
    expect(result.content[0]?.type).toBe("text");
  });

  it("passes only present args when caller omits fields", async () => {
    const ref = makeClientRef();
    const spy = jest
      .spyOn(ref.current, "searchAuditEventsStrict")
      .mockResolvedValue({ entries: [], total: 0 });

    const tool = buildAuditSearchTool(ref);
    await tool.execute("call-1", {});
    expect(spy).toHaveBeenCalledWith({
      startTime: undefined,
      endTime: undefined,
      requestType: undefined,
      limit: undefined,
    });
  });

  it("returns isError when the client throws", async () => {
    const ref = makeClientRef();
    jest.spyOn(ref.current, "searchAuditEventsStrict").mockRejectedValue(new Error("boom"));
    const tool = buildAuditSearchTool(ref);
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Error: boom");
  });

  it("surfaces a 503 transport failure as isError, not as 'no audit events'", async () => {
    // Regression: the previous implementation called the lossy
    // searchAuditEvents which collapses non-2xx into {entries:[], total:0}.
    // An agent reading that during a platform outage would say "no audit
    // events" and move on. The strict variant must surface it as isError.
    const ref = makeClientRef();
    jest
      .spyOn(ref.current, "searchAuditEventsStrict")
      .mockRejectedValue(
        new AxonFlowHttpError(503, "Service Unavailable", { error: "down" }, "audit search"),
      );
    const tool = buildAuditSearchTool(ref);
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("HTTP 503");
    expect((result.details as { status: number }).status).toBe(503);
  });
});

describe("axonflow_explain_decision", () => {
  it("rejects empty decision_id", async () => {
    const ref = makeClientRef();
    const tool = buildExplainDecisionTool(ref);
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("decision_id is required");
  });

  it("returns ok payload when client returns explanation", async () => {
    const ref = makeClientRef();
    jest.spyOn(ref.current, "explainDecisionStrict").mockResolvedValue({
      kind: "ok",
      explanation: {
        decision_id: "dec-42",
        timestamp: "2026-05-03T00:00:00Z",
        policy_matches: [],
        decision: "deny",
        reason: "matched policy X",
        override_available: false,
        historical_hit_count_session: 0,
      },
    });
    const tool = buildExplainDecisionTool(ref);
    const result = await tool.execute("call-1", { decision_id: "dec-42" });
    expect(result.isError).toBeUndefined();
    expect((result.details as { decision_id: string }).decision_id).toBe("dec-42");
  });

  it("returns isError with not_found:true on a 404", async () => {
    const ref = makeClientRef();
    jest
      .spyOn(ref.current, "explainDecisionStrict")
      .mockResolvedValue({ kind: "not_found" });
    const tool = buildExplainDecisionTool(ref);
    const result = await tool.execute("call-1", { decision_id: "missing" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No explanation found");
    expect((result.details as { not_found: boolean }).not_found).toBe(true);
  });

  it("surfaces transport / non-2xx as isError (not as 'no explanation available')", async () => {
    const ref = makeClientRef();
    jest
      .spyOn(ref.current, "explainDecisionStrict")
      .mockRejectedValue(
        new AxonFlowHttpError(503, "Service Unavailable", { error: "down" }, "explain decision"),
      );
    const tool = buildExplainDecisionTool(ref);
    const result = await tool.execute("call-1", { decision_id: "dec-42" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("HTTP 503 Service Unavailable");
    expect((result.details as { status: number }).status).toBe(503);
  });

  it("forwards AxonFlowHttpError details on 403", async () => {
    const ref = makeClientRef();
    jest
      .spyOn(ref.current, "explainDecisionStrict")
      .mockRejectedValue(
        new AxonFlowHttpError(403, "Forbidden", { error: "denied" }, "explain"),
      );
    const tool = buildExplainDecisionTool(ref);
    const result = await tool.execute("call-1", { decision_id: "dec-42" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("HTTP 403 Forbidden");
    expect((result.details as { status: number }).status).toBe(403);
  });

  it("surfaces network errors (no AxonFlowHttpError) as isError", async () => {
    const ref = makeClientRef();
    jest
      .spyOn(ref.current, "explainDecisionStrict")
      .mockRejectedValue(new Error("ECONNREFUSED"));
    const tool = buildExplainDecisionTool(ref);
    const result = await tool.execute("call-1", { decision_id: "dec-42" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("ECONNREFUSED");
  });
});

describe("axonflow_list_overrides", () => {
  it("forwards optional filters", async () => {
    const ref = makeClientRef();
    const spy = jest
      .spyOn(ref.current, "listOverridesStrict")
      .mockResolvedValue({ overrides: [], count: 0 });
    const tool = buildListOverridesTool(ref);
    await tool.execute("call-1", { policy_id: "POL-1", include_revoked: true });
    expect(spy).toHaveBeenCalledWith({ policyId: "POL-1", includeRevoked: true });
  });

  it("calls client without filters when args empty", async () => {
    const ref = makeClientRef();
    const spy = jest
      .spyOn(ref.current, "listOverridesStrict")
      .mockResolvedValue({ overrides: [], count: 0 });
    const tool = buildListOverridesTool(ref);
    await tool.execute("call-1", {});
    expect(spy).toHaveBeenCalledWith({ policyId: undefined, includeRevoked: undefined });
  });

  it("surfaces client errors as isError", async () => {
    const ref = makeClientRef();
    jest.spyOn(ref.current, "listOverridesStrict").mockRejectedValue(new Error("net down"));
    const tool = buildListOverridesTool(ref);
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBe(true);
  });

  it("surfaces a 503 transport failure as isError, not as 'no overrides'", async () => {
    // Regression: previous implementation called the lossy listOverrides
    // which collapses non-2xx into {overrides:[], count:0}. An agent
    // reading that during an outage would conclude "no active overrides"
    // and possibly retry a previously-blocked tool call. The strict
    // variant must surface it as isError.
    const ref = makeClientRef();
    jest
      .spyOn(ref.current, "listOverridesStrict")
      .mockRejectedValue(
        new AxonFlowHttpError(503, "Service Unavailable", { error: "down" }, "list overrides"),
      );
    const tool = buildListOverridesTool(ref);
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBe(true);
    expect((result.details as { status: number }).status).toBe(503);
  });

  it("ignores unknown arg types (numeric policy_id, string include_revoked)", async () => {
    const ref = makeClientRef();
    const spy = jest
      .spyOn(ref.current, "listOverridesStrict")
      .mockResolvedValue({ overrides: [], count: 0 });
    const tool = buildListOverridesTool(ref);
    await tool.execute("call-1", { policy_id: 42, include_revoked: "true" });
    expect(spy).toHaveBeenCalledWith({ policyId: undefined, includeRevoked: undefined });
  });
});

describe("axonflow_create_override", () => {
  it("rejects missing required fields", async () => {
    const ref = makeClientRef();
    const tool = buildCreateOverrideTool(ref);

    let result = await tool.execute("call-1", { policy_type: "static", override_reason: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("policy_id is required");

    result = await tool.execute("call-1", { policy_id: "P", policy_type: "static" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("override_reason is required");
  });

  it("rejects invalid policy_type", async () => {
    const ref = makeClientRef();
    const tool = buildCreateOverrideTool(ref);
    const result = await tool.execute("call-1", {
      policy_id: "P",
      policy_type: "garbage",
      override_reason: "test",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("policy_type must be");
  });

  it("forwards mapped fields including optional tool_signature + ttl_seconds", async () => {
    const ref = makeClientRef();
    const spy = jest.spyOn(ref.current, "createOverride").mockResolvedValue({
      id: "ovr-1",
      policy_id: "P",
      policy_type: "static",
      expires_at: "2026-05-03T01:00:00Z",
      ttl_seconds: 3600,
      created_at: "2026-05-03T00:00:00Z",
    });
    const tool = buildCreateOverrideTool(ref);
    const result = await tool.execute("call-1", {
      policy_id: "P",
      policy_type: "dynamic",
      override_reason: "demo",
      tool_signature: "Bash",
      ttl_seconds: 600,
    });
    expect(spy).toHaveBeenCalledWith({
      policyId: "P",
      policyType: "dynamic",
      overrideReason: "demo",
      toolSignature: "Bash",
      ttlSeconds: 600,
    });
    expect(result.isError).toBeUndefined();
  });

  it("surfaces 403 from server as isError with status detail", async () => {
    const ref = makeClientRef();
    jest.spyOn(ref.current, "createOverride").mockRejectedValue(
      new AxonFlowHttpError(403, "Forbidden", { error: "critical-risk" }, "create override"),
    );
    const tool = buildCreateOverrideTool(ref);
    const result = await tool.execute("call-1", {
      policy_id: "P",
      policy_type: "static",
      override_reason: "demo",
    });
    expect(result.isError).toBe(true);
    expect((result.details as { status: number }).status).toBe(403);
  });
});

describe("axonflow_revoke_override", () => {
  it("rejects empty override_id", async () => {
    const ref = makeClientRef();
    const tool = buildRevokeOverrideTool(ref);
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("override_id is required");
  });

  it("returns revoked confirmation on success", async () => {
    const ref = makeClientRef();
    jest.spyOn(ref.current, "revokeOverride").mockResolvedValue();
    const tool = buildRevokeOverrideTool(ref);
    const result = await tool.execute("call-1", { override_id: "ovr-7" });
    expect(result.isError).toBeUndefined();
    expect((result.details as { revoked: boolean }).revoked).toBe(true);
    expect((result.details as { override_id: string }).override_id).toBe("ovr-7");
  });

  it("surfaces 404 from server as isError", async () => {
    const ref = makeClientRef();
    jest.spyOn(ref.current, "revokeOverride").mockRejectedValue(
      new AxonFlowHttpError(404, "Not Found", { error: "no such override" }, "revoke override"),
    );
    const tool = buildRevokeOverrideTool(ref);
    const result = await tool.execute("call-1", { override_id: "ovr-missing" });
    expect(result.isError).toBe(true);
    expect((result.details as { status: number }).status).toBe(404);
  });

  it("handles unknown error type without crashing", async () => {
    const ref = makeClientRef();
    jest.spyOn(ref.current, "revokeOverride").mockRejectedValue("not-an-error-instance");
    const tool = buildRevokeOverrideTool(ref);
    const result = await tool.execute("call-1", { override_id: "ovr-7" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown error");
  });
});
