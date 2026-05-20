import { AxonFlowClient } from "../src/axonflow-client.js";

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function makeClient() {
  return new AxonFlowClient({
    endpoint: "http://localhost:8080",
    clientId: "test-client",
    clientSecret: "test-secret",
    mode: "self-hosted",
  });
}

function jsonResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("AxonFlowClient", () => {
  describe("mcpCheckInput", () => {
    it("returns allowed response", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { allowed: true, policies_evaluated: 76 }),
      );
      const client = makeClient();
      const result = await client.mcpCheckInput("openclaw.web_fetch", '{"url": "https://x.com"}');

      expect(result.allowed).toBe(true);
      expect(result.policies_evaluated).toBe(76);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/api/v1/mcp/check-input",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: expect.stringContaining("Basic"),
          }),
        }),
      );
    });

    it("extracts policies_evaluated from policy_info (number)", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          allowed: true,
          policy_info: { policies_evaluated: 42, blocked: false },
        }),
      );
      const client = makeClient();
      const result = await client.mcpCheckInput("test", "stmt");
      expect(result.policies_evaluated).toBe(42);
    });

    it("extracts policies_evaluated from policy_info (array)", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          allowed: true,
          policy_info: { policies_evaluated: ["sys_pii_ssn", "sys_sqli_drop"] },
        }),
      );
      const client = makeClient();
      const result = await client.mcpCheckInput("test", "stmt");
      expect(result.policies_evaluated).toBe(2);
    });

    it("defaults policies_evaluated to 0 when missing", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { allowed: true }),
      );
      const client = makeClient();
      const result = await client.mcpCheckInput("test", "stmt");
      expect(result.policies_evaluated).toBe(0);
    });

    it("returns blocked on 403 with block_reason", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(403, { block_reason: "PII detected", policies_evaluated: 76 }),
      );
      const client = makeClient();
      const result = await client.mcpCheckInput("openclaw.message", '{"text": "SSN 123-45-6789"}');

      expect(result.allowed).toBe(false);
      expect(result.block_reason).toBe("PII detected");
      expect(result.policies_evaluated).toBe(76);
    });

    it("falls back to error field on 403 without block_reason", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(403, { error: "Request blocked: DROP TABLE" }),
      );
      const client = makeClient();
      const result = await client.mcpCheckInput("test", "stmt");
      expect(result.block_reason).toBe("Request blocked: DROP TABLE");
    });

    it("throws on non-403 errors", async () => {
      // v1.2.1: AxonFlowHttpError class now carries status as a dedicated
      // field, and the error message format changed to include "HTTP <status>".
      mockFetch.mockResolvedValueOnce(jsonResponse(500, { error: "Internal error" }));
      const client = makeClient();
      await expect(
        client.mcpCheckInput("test", "statement"),
      ).rejects.toThrow(/check-input failed.*500/);
    });

    it("throws AxonFlowHttpError with .status field on non-403", async () => {
      // v1.2.1 regression test: the thrown error must expose .status so
      // isAxonFlowAuthError in governance.ts can use the status-based path
      // without falling back to message matching.
      const { AxonFlowHttpError } = await import("../src/axonflow-client.js");
      mockFetch.mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }));
      const client = makeClient();
      try {
        await client.mcpCheckInput("test", "statement");
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AxonFlowHttpError);
        expect((err as InstanceType<typeof AxonFlowHttpError>).status).toBe(401);
      }
    });

    it("sends correct auth header", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { allowed: true, policies_evaluated: 0 }),
      );
      const client = makeClient();
      await client.mcpCheckInput("test", "stmt");

      const call = mockFetch.mock.calls[0];
      const headers = (call?.[1] as RequestInit).headers as Record<string, string>;
      const expectedAuth = `Basic ${Buffer.from("test-client:test-secret").toString("base64")}`;
      expect(headers["Authorization"]).toBe(expectedAuth);
      expect(headers["X-Tenant-ID"]).toBeUndefined();
    });

    it("passes operation parameter", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { allowed: true, policies_evaluated: 0 }),
      );
      const client = makeClient();
      await client.mcpCheckInput("test", "stmt", "query");

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse((call?.[1] as RequestInit).body as string);
      expect(body.operation).toBe("query");
    });
  });

  describe("mcpCheckOutput", () => {
    it("returns allowed response", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { allowed: true, policies_evaluated: 76 }),
      );
      const client = makeClient();
      const result = await client.mcpCheckOutput("openclaw.search", "clean data");

      expect(result.allowed).toBe(true);
      expect(result.redacted_data).toBeUndefined();
    });

    it("returns redacted data", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          allowed: true,
          redacted_data: "Name: John, SSN: ***-**-6789",
          policies_evaluated: 76,
        }),
      );
      const client = makeClient();
      const result = await client.mcpCheckOutput("openclaw.search", "Name: John, SSN: 123-45-6789");

      expect(result.allowed).toBe(true);
      expect(result.redacted_data).toBe("Name: John, SSN: ***-**-6789");
    });

    it("extracts policies from policy_info on 200", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          allowed: true,
          policy_info: { policies_evaluated: 76, blocked: false },
        }),
      );
      const client = makeClient();
      const result = await client.mcpCheckOutput("test", "data");
      expect(result.policies_evaluated).toBe(76);
    });

    it("returns blocked on 403 with block_reason", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(403, { block_reason: "Exfiltration detected" }),
      );
      const client = makeClient();
      const result = await client.mcpCheckOutput("openclaw.search", "10000 rows");

      expect(result.allowed).toBe(false);
      expect(result.block_reason).toBe("Exfiltration detected");
    });

    it("falls back to error on 403 without block_reason", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(403, { error: "Blocked by policy" }),
      );
      const client = makeClient();
      const result = await client.mcpCheckOutput("test", "data");
      expect(result.block_reason).toBe("Blocked by policy");
    });

    it("throws on non-403 errors", async () => {
      // v1.2.1: AxonFlowHttpError with "HTTP <status>" in message.
      mockFetch.mockResolvedValueOnce(jsonResponse(500, { error: "Server error" }));
      const client = makeClient();
      await expect(
        client.mcpCheckOutput("test", "data"),
      ).rejects.toThrow(/check-output failed.*500/);
    });
  });

  describe("auditToolCall", () => {
    it("sends audit request", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, { success: true }));
      const client = makeClient();
      await client.auditToolCall("web_fetch", { url: "https://x.com" }, "result", undefined, 100);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/api/v1/audit/tool-call",
        expect.objectContaining({ method: "POST" }),
      );
      const body = JSON.parse(
        (mockFetch.mock.calls[0]?.[1] as RequestInit).body as string,
      );
      expect(body.tool_name).toBe("web_fetch");
      expect(body.tool_type).toBe("openclaw");
      expect(body.input).toEqual({ url: "https://x.com" });
      expect(body.output).toEqual({ result: '"result"' });
      expect(body.success).toBe(true);
      expect(body.error_message).toBeUndefined();
      expect(body.duration_ms).toBe(100);
    });

    it("does not throw on failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));
      const client = makeClient();
      // Should not throw
      await client.auditToolCall("tool", {});
    });
  });

  describe("auditLLMCall", () => {
    it("uses audit/tool-call endpoint with tool_type llm_call", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, { success: true }));
      const client = makeClient();
      await client.auditLLMCall(
        "anthropic", "claude-sonnet-4-6",
        "Hello world", "Hi there!",
        { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        150,
      );

      // Must use audit/tool-call, NOT audit/llm-call (which requires context_id)
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/api/v1/audit/tool-call",
        expect.objectContaining({ method: "POST" }),
      );

      const call = mockFetch.mock.calls[0];
      const headers = (call?.[1] as RequestInit).headers as Record<string, string>;
      expect(headers["X-Tenant-ID"]).toBeUndefined();

      const body = JSON.parse((call?.[1] as RequestInit).body as string);
      expect(body.tool_name).toBe("anthropic.claude-sonnet-4-6");
      expect(body.tool_type).toBe("llm_call");
      expect(body.input.query).toBe("Hello world");
      expect(body.output.response_summary).toBe("Hi there!");
      expect(body.success).toBe(true);
      expect(body.duration_ms).toBe(150);
    });

    it("does not throw on failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));
      const client = makeClient();
      await client.auditLLMCall("test", "model", "q", "r", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, 0);
    });
  });

  describe("searchAuditEvents", () => {
    it("returns entries on success", async () => {
      const mockEntries = [{ id: "audit_1", tool_name: "exec" }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ entries: mockEntries, total: 1 }),
      });
      const client = makeClient();
      const result = await client.searchAuditEvents({ limit: 5 });
      expect(result.entries).toEqual(mockEntries);
      expect(result.total).toBe(1);
    });

    it("returns error on HTTP failure", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
      const client = makeClient();
      const result = await client.searchAuditEvents();
      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.error).toBe("HTTP 401");
    });

    it("returns error on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));
      const client = makeClient();
      const result = await client.searchAuditEvents();
      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.error).toBe("Network error");
    });

    it("uses default time range when not specified", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ entries: [], total: 0 }),
      });
      const client = makeClient();
      await client.searchAuditEvents();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/audit/search"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("start_time"),
        }),
      );
    });

    it("passes request_type filter", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ entries: [], total: 0 }),
      });
      const client = makeClient();
      await client.searchAuditEvents({ requestType: "tool_call_audit" });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.stringContaining("tool_call_audit"),
        }),
      );
    });

    it("caps limit at 100", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ entries: [], total: 0 }),
      });
      const client = makeClient();
      await client.searchAuditEvents({ limit: 500 });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.limit).toBe(100);
    });
  });

  // ─── Strict variants used by agent-callable tools ────────────────────
  // These methods MUST throw on transport / non-2xx so the agent tool
  // wrappers can surface the failure as isError. The CLI-flavored
  // counterparts (searchAuditEvents / listOverrides / explainDecision)
  // intentionally swallow errors and stay on this codebase.

  describe("searchAuditEventsStrict", () => {
    it("returns the parsed body on 200", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { entries: [{ id: "e1" }], total: 1 }),
      );
      const client = makeClient();
      const result = await client.searchAuditEventsStrict({});
      expect(result.total).toBe(1);
      expect(Array.isArray(result.entries)).toBe(true);
    });

    it("coerces server-returned entries:null to []", async () => {
      // Defensive against older platform deployments still serving
      // `entries: null` before the axonflow-enterprise#1834 fix lands.
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { entries: null, total: 0 }),
      );
      const client = makeClient();
      const result = await client.searchAuditEventsStrict({});
      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("throws AxonFlowHttpError on non-2xx", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: () => Promise.resolve("down"),
      });
      const client = makeClient();
      await expect(client.searchAuditEventsStrict({})).rejects.toThrow(
        /HTTP 503/,
      );
    });

    it("propagates network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const client = makeClient();
      await expect(client.searchAuditEventsStrict({})).rejects.toThrow(
        "ECONNREFUSED",
      );
    });
  });

  describe("listOverridesStrict", () => {
    it("returns the parsed body on 200", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { overrides: [], count: 0 }),
      );
      const client = makeClient();
      const result = await client.listOverridesStrict();
      expect(result.count).toBe(0);
    });

    it("throws AxonFlowHttpError on non-2xx", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: () => Promise.resolve("invalid auth"),
      });
      const client = makeClient();
      await expect(client.listOverridesStrict()).rejects.toThrow(/HTTP 401/);
    });

    it("forwards optional filters in the query string", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { overrides: [], count: 0 }),
      );
      const client = makeClient();
      await client.listOverridesStrict({ policyId: "P", includeRevoked: true });
      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain("policy_id=P");
      expect(url).toContain("include_revoked=true");
    });
  });

  describe("explainDecisionStrict", () => {
    it("returns kind:ok with the explanation on 200", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, {
          decision_id: "dec-42",
          timestamp: "2026-05-03T00:00:00Z",
          policy_matches: [],
          decision: "deny",
          reason: "blocked",
          override_available: false,
          historical_hit_count_session: 0,
        }),
      );
      const client = makeClient();
      const result = await client.explainDecisionStrict("dec-42");
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.explanation.decision_id).toBe("dec-42");
      }
    });

    it("returns kind:not_found on 404 (not the same as a transport error)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: () => Promise.resolve(""),
      });
      const client = makeClient();
      const result = await client.explainDecisionStrict("missing");
      expect(result.kind).toBe("not_found");
    });

    it("throws AxonFlowHttpError on 5xx (distinct from 404)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: () => Promise.resolve("down"),
      });
      const client = makeClient();
      await expect(client.explainDecisionStrict("dec-42")).rejects.toThrow(
        /HTTP 503/,
      );
    });

    it("throws Error on missing decisionId without hitting the network", async () => {
      const client = makeClient();
      await expect(client.explainDecisionStrict("")).rejects.toThrow(
        "decisionId is required",
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("healthCheck", () => {
    it("returns true when healthy", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      const client = makeClient();
      expect(await client.healthCheck()).toBe(true);
    });

    it("returns false when unhealthy", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });
      const client = makeClient();
      expect(await client.healthCheck()).toBe(false);
    });

    it("returns false on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const client = makeClient();
      expect(await client.healthCheck()).toBe(false);
    });
  });

  describe("endpoint normalization", () => {
    it("strips trailing slashes", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { allowed: true, policies_evaluated: 0 }),
      );
      const client = new AxonFlowClient({
        endpoint: "http://localhost:8080///",
        clientId: "id",
        clientSecret: "secret",
        mode: "self-hosted",
      });
      await client.mcpCheckInput("test", "stmt");

      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toBe("http://localhost:8080/api/v1/mcp/check-input");
    });
  });

  describe("auth-failure circuit breaker (issue #2275)", () => {
    // The plugin's audit hook is fire-and-forget: every after_tool_call
    // POSTs /api/v1/audit/tool-call and the catch block silently swallows
    // errors. When the configured credentials are wrong, every tool call
    // produces a 401 — which is what generated the 716 × 401 / 24h storm
    // in axonflow-enterprise#2275. Fix: once we observe a 401, flip the
    // process-local `authFailed` flag and short-circuit subsequent calls.

    let warnSpy: jest.SpyInstance;
    beforeEach(() => {
      warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("auditToolCall on 401 sets authFailed flag and skips subsequent fetches", async () => {
      // First call: real 401 from the wire. The fetch IS issued so the
      // client observes the response status; the audit method itself
      // doesn't throw (fire-and-forget contract preserved).
      mockFetch.mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }));
      const client = makeClient();
      await client.auditToolCall("web_fetch", { url: "https://x.com" });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(client.isAuthFailed()).toBe(true);

      // Second + third calls: short-circuited before the fetch. mockFetch
      // call count stays at 1 — this is the actual fix for the 401 storm.
      mockFetch.mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }));
      await client.auditToolCall("tool_b", {});
      await client.auditToolCall("tool_c", {});
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Operator sees exactly one warn.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/Authentication failed.*HTTP 401/);
    });

    it("auditLLMCall on 401 sets authFailed flag and skips subsequent fetches", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }));
      const client = makeClient();
      await client.auditLLMCall(
        "anthropic", "claude-sonnet-4-6", "q", "r",
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, 0,
      );
      expect(client.isAuthFailed()).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Subsequent llm-audit calls short-circuit.
      await client.auditLLMCall(
        "anthropic", "claude-sonnet-4-6", "q2", "r2",
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, 0,
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Cross-method short-circuit: auditToolCall also no-ops now.
      await client.auditToolCall("tool_z", {});
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("mcpCheckInput on 401 short-circuits subsequent calls without fetching", async () => {
      const { AxonFlowHttpError } = await import("../src/axonflow-client.js");

      // First call: real 401 from the wire. Throws AxonFlowHttpError
      // (existing behavior) AND flips the flag.
      mockFetch.mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }));
      const client = makeClient();
      await expect(client.mcpCheckInput("test", "stmt")).rejects.toBeInstanceOf(
        AxonFlowHttpError,
      );
      expect(client.isAuthFailed()).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call: should NOT issue a fetch. Still throws the same
      // AxonFlowHttpError shape so governance.ts's onError path fires.
      try {
        await client.mcpCheckInput("test", "stmt2");
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AxonFlowHttpError);
        expect((err as InstanceType<typeof AxonFlowHttpError>).status).toBe(401);
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("mcpCheckOutput on 401 short-circuits subsequent calls without fetching", async () => {
      const { AxonFlowHttpError } = await import("../src/axonflow-client.js");
      mockFetch.mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }));
      const client = makeClient();
      await expect(client.mcpCheckOutput("test", "data")).rejects.toBeInstanceOf(
        AxonFlowHttpError,
      );
      expect(client.isAuthFailed()).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await expect(client.mcpCheckOutput("test", "data2")).rejects.toBeInstanceOf(
        AxonFlowHttpError,
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("console.warn is emitted exactly once across multiple 401s from different methods", async () => {
      const client = makeClient();
      // Five 401s in a row from a mix of entry points.
      mockFetch.mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }));
      await client.auditToolCall("a", {});

      // auditLLMCall short-circuits — no fetch, no second warn.
      await client.auditLLMCall(
        "anthropic", "claude", "q", "r",
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, 0,
      );

      // mcpCheckInput also short-circuits, throws but no second warn.
      await expect(client.mcpCheckInput("t", "s")).rejects.toThrow();

      // mcpCheckOutput likewise.
      await expect(client.mcpCheckOutput("t", "d")).rejects.toThrow();

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("each new AxonFlowClient instance starts fresh", async () => {
      // The process-local flag must not leak across clients — if the
      // host hot-reloads its config with fresh credentials, the new
      // client instance starts from a clean slate.
      mockFetch.mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }));
      const c1 = makeClient();
      await c1.auditToolCall("a", {});
      expect(c1.isAuthFailed()).toBe(true);

      const c2 = makeClient();
      expect(c2.isAuthFailed()).toBe(false);

      mockFetch.mockResolvedValueOnce(jsonResponse(200, { success: true }));
      await c2.auditToolCall("b", {});
      // c2 issued its own fetch — confirmed by the fact that this 200
      // response was consumed (call count moves from 1 to 2).
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(c2.isAuthFailed()).toBe(false);
    });

    it("non-401 errors do NOT trip the breaker (transient 5xx must keep retrying)", async () => {
      // 500/503 are transient — governance.ts intentionally fails OPEN
      // on them and the next governed call should re-attempt the
      // network. Flipping the breaker on 5xx would cause a single
      // transient outage to permanently disable audit for the session.
      mockFetch.mockResolvedValueOnce(jsonResponse(500, { error: "Internal" }));
      const client = makeClient();
      await client.auditToolCall("a", {});
      expect(client.isAuthFailed()).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();

      // Next call should still issue a fetch.
      mockFetch.mockResolvedValueOnce(jsonResponse(200, { success: true }));
      await client.auditToolCall("b", {});
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("concurrent 401s emit exactly one warn (race-free under Node single-thread)", async () => {
      // Three concurrent audit POSTs all returning 401: at most one
      // warn must surface. Node's single-threaded event loop means the
      // resolve→sync-code window between markAuthFailed checks is
      // race-free, but the assertion guards against future refactors
      // that introduce real async between the flag set and warn emit.
      mockFetch
        .mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }))
        .mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }))
        .mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }));
      const client = makeClient();
      await Promise.all([
        client.auditToolCall("a", {}),
        client.auditToolCall("b", {}),
        client.auditToolCall("c", {}),
      ]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(client.isAuthFailed()).toBe(true);
    });
  });

  describe("X-User-Email forwarding (Plugin Batch 1)", () => {
    it("emits X-User-Email when userEmail is set on config", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { allowed: true, policies_evaluated: 0 }),
      );
      const client = new AxonFlowClient({
        endpoint: "http://localhost:8080",
        clientId: "test-client",
        clientSecret: "test-secret",
        userEmail: "alice@example.com",
        mode: "self-hosted",
      });
      await client.mcpCheckInput("postgres", "SELECT 1");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-User-Email": "alice@example.com",
          }),
        }),
      );
    });

    it("omits X-User-Email when userEmail is not set", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { allowed: true, policies_evaluated: 0 }),
      );
      const client = makeClient();
      await client.mcpCheckInput("postgres", "SELECT 1");

      const headers = (mockFetch.mock.calls[0]?.[1] as RequestInit)?.headers as
        | Record<string, string>
        | undefined;
      expect(headers).toBeDefined();
      expect(headers && "X-User-Email" in headers).toBe(false);
    });

    it("forwards X-User-Email on override lifecycle endpoints", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(201, { id: "ov-1", policy_id: "p1" }),
      );
      const client = new AxonFlowClient({
        endpoint: "http://localhost:8080",
        clientId: "c",
        clientSecret: "s",
        userEmail: "ops@example.com",
        mode: "self-hosted",
      });
      await client.createOverride({
        policyId: "sys_sqli_admin_bypass",
        policyType: "static",
        overrideReason: "approved debug window",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/api/v1/overrides",
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-User-Email": "ops@example.com",
          }),
        }),
      );
    });
  });
});
