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
