/**
 * Tests for Plugin Batch 1: explainDecision + session overrides (ADR-042 + ADR-043).
 */

import { AxonFlowClient, AxonFlowHttpError } from "../src/axonflow-client.js";

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function makeClient() {
  return new AxonFlowClient({
    endpoint: "http://localhost:8080",
    clientId: "test-client",
    clientSecret: "test-secret",
  });
}

function textResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: () => Promise.resolve(body),
  };
}

function jsonResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : status === 204 ? "No Content" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("AxonFlowClient.explainDecision (ADR-043)", () => {
  it("returns null for empty decision id", async () => {
    const client = makeClient();
    const result = await client.explainDecision("");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns the full DecisionExplanation on 200", async () => {
    const client = makeClient();
    const body = {
      decision_id: "dec-1",
      timestamp: "2026-04-17T12:00:00Z",
      decision: "deny",
      reason: "SQL injection detected",
      risk_level: "high",
      policy_matches: [
        {
          policy_id: "pol-sqli",
          policy_name: "SQL Injection Detector",
          action: "deny",
          risk_level: "high",
          allow_override: true,
          policy_description: "Blocks SQL injection",
        },
      ],
      override_available: true,
      override_existing_id: "ov-abc",
      historical_hit_count_session: 3,
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(200, body));

    const result = await client.explainDecision("dec-1");
    expect(result).not.toBeNull();
    expect(result!.decision_id).toBe("dec-1");
    expect(result!.policy_matches).toHaveLength(1);
    expect(result!.override_available).toBe(true);
    expect(result!.override_existing_id).toBe("ov-abc");
    expect(result!.historical_hit_count_session).toBe(3);

    const call = mockFetch.mock.calls[0];
    expect(call[0]).toContain("/api/v1/decisions/dec-1/explain");
    expect((call[1] as { method: string }).method).toBe("GET");
  });

  it("URL-encodes the decision id", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {} as Record<string, unknown>));
    await client.explainDecision("a/b");
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("a%2Fb/explain");
  });

  it("returns null on 404 rather than throwing", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { error: "Decision not found" }));
    const result = await client.explainDecision("dec-missing");
    expect(result).toBeNull();
  });

  it("returns null on network failure rather than throwing", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new Error("network down"));
    const result = await client.explainDecision("dec-1");
    expect(result).toBeNull();
  });
});

describe("AxonFlowClient.createOverride (ADR-042)", () => {
  it("throws for empty override reason (ADR-042 mandatory justification)", async () => {
    const client = makeClient();
    await expect(
      client.createOverride({
        policyId: "p-1",
        policyType: "static",
        overrideReason: "",
      }),
    ).rejects.toThrow(/required/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws for whitespace-only reason", async () => {
    const client = makeClient();
    await expect(
      client.createOverride({
        policyId: "p-1",
        policyType: "static",
        overrideReason: "   \n  ",
      }),
    ).rejects.toThrow(/required/);
  });

  it("posts full payload on success and returns the created override", async () => {
    const client = makeClient();
    const serverResponse = {
      id: "ov-abc",
      policy_id: "p-1",
      policy_type: "static",
      expires_at: "2026-04-17T13:00:00Z",
      ttl_seconds: 3600,
      created_at: "2026-04-17T12:00:00Z",
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(201, serverResponse));

    const result = await client.createOverride({
      policyId: "p-1",
      policyType: "static",
      overrideReason: "Debugging production issue",
      toolSignature: "Bash",
      ttlSeconds: 1800,
    });

    expect(result.id).toBe("ov-abc");

    const call = mockFetch.mock.calls[0];
    expect(call[0]).toContain("/api/v1/overrides");
    expect((call[1] as { method: string }).method).toBe("POST");
    const sentBody = JSON.parse((call[1] as { body: string }).body);
    expect(sentBody.policy_id).toBe("p-1");
    expect(sentBody.override_reason).toBe("Debugging production issue");
    expect(sentBody.tool_signature).toBe("Bash");
    expect(sentBody.ttl_seconds).toBe(1800);
  });

  it("throws AxonFlowHttpError on 403 (critical-risk policy)", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      textResponse(403, "Critical-risk policies cannot be overridden"),
    );
    await expect(
      client.createOverride({
        policyId: "p-critical",
        policyType: "static",
        overrideReason: "test",
      }),
    ).rejects.toThrow(AxonFlowHttpError);
  });

  it("omits tool_signature + ttl_seconds when unset", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        id: "ov-1",
        policy_id: "p-1",
        policy_type: "static",
        expires_at: "2026-04-17T13:00:00Z",
        ttl_seconds: 3600,
        created_at: "2026-04-17T12:00:00Z",
      }),
    );
    await client.createOverride({
      policyId: "p-1",
      policyType: "static",
      overrideReason: "test",
    });
    const sentBody = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(sentBody.tool_signature).toBeUndefined();
    expect(sentBody.ttl_seconds).toBeUndefined();
  });
});

describe("AxonFlowClient.revokeOverride", () => {
  it("throws for empty override id", async () => {
    const client = makeClient();
    await expect(client.revokeOverride("")).rejects.toThrow(/required/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("DELETEs the correct URL on success", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { id: "ov-1" }));
    await client.revokeOverride("ov-1");
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toContain("/api/v1/overrides/ov-1");
    expect((call[1] as { method: string }).method).toBe("DELETE");
  });

  it("throws AxonFlowHttpError on 404", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse(404, "Override not found"));
    await expect(client.revokeOverride("ov-missing")).rejects.toThrow(AxonFlowHttpError);
  });
});

describe("AxonFlowClient.listOverrides", () => {
  it("returns empty when server errors", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    const result = await client.listOverrides();
    expect(result.overrides).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("passes policy_id and include_revoked as query params", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { overrides: [], count: 0 }));
    await client.listOverrides({ policyId: "p-1", includeRevoked: true });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("policy_id=p-1");
    expect(url).toContain("include_revoked=true");
  });
});
