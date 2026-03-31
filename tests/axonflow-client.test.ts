import { AxonFlowClient } from "../src/axonflow-client.js";

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function makeClient() {
  return new AxonFlowClient({
    endpoint: "http://localhost:8080",
    clientId: "test-client",
    clientSecret: "test-secret",
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

    it("returns blocked on 403", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(403, { error: "PII detected", policies_evaluated: 76 }),
      );
      const client = makeClient();
      const result = await client.mcpCheckInput("openclaw.message", '{"text": "SSN 123-45-6789"}');

      expect(result.allowed).toBe(false);
      expect(result.block_reason).toBe("PII detected");
    });

    it("throws on non-403 errors", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(500, { error: "Internal error" }));
      const client = makeClient();
      await expect(
        client.mcpCheckInput("test", "statement"),
      ).rejects.toThrow("check-input failed: 500");
    });

    it("sends correct auth header", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { allowed: true, policies_evaluated: 0 }),
      );
      const client = makeClient();
      await client.mcpCheckInput("test", "stmt");

      const call = mockFetch.mock.calls[0];
      const headers = (call?.[1] as RequestInit).headers as Record<string, string>;
      // base64("test-client:test-secret") = "dGVzdC1jbGllbnQ6dGVzdC1zZWNyZXQ="
      expect(headers["Authorization"]).toBe("Basic dGVzdC1jbGllbnQ6dGVzdC1zZWNyZXQ=");
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

    it("returns blocked on 403", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(403, { error: "Exfiltration detected" }),
      );
      const client = makeClient();
      const result = await client.mcpCheckOutput("openclaw.search", "10000 rows");

      expect(result.allowed).toBe(false);
      expect(result.block_reason).toBe("Exfiltration detected");
    });

    it("throws on non-403 errors", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(500, { error: "Server error" }));
      const client = makeClient();
      await expect(
        client.mcpCheckOutput("test", "data"),
      ).rejects.toThrow("check-output failed: 500");
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
      expect(body.duration_ms).toBe(100);
    });

    it("does not throw on failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));
      const client = makeClient();
      // Should not throw
      await client.auditToolCall("tool", {});
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
      });
      await client.mcpCheckInput("test", "stmt");

      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toBe("http://localhost:8080/api/v1/mcp/check-input");
    });
  });
});
