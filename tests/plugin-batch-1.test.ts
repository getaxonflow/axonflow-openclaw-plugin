/**
 * Tests for Plugin Batch 1: explainDecision and the richer block context
 * (ADR-042 + ADR-043). The session override writes are retired from AxonFlow
 * v11.0.0 and the client no longer offers them (agent-tools.test.ts pins that).
 */

import { AxonFlowClient } from "../src/axonflow-client.js";

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

describe("AxonFlowClient.mcpCheckInput — richer context propagation (Plugin Batch 1)", () => {
  it("surfaces decision_id + risk_level + override fields from a 200 allow", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        allowed: true,
        policies_evaluated: 3,
        decision_id: "dec-abc",
        risk_level: "medium",
        override_available: false,
        policy_matches: [
          {
            policy_id: "pol-1",
            policy_name: "Test Policy",
            action: "allow",
            risk_level: "medium",
            allow_override: true,
            policy_description: "A policy",
          },
        ],
      }),
    );

    const resp = await client.mcpCheckInput("openclaw.Bash", "ls", "execute");

    expect(resp.allowed).toBe(true);
    expect(resp.decision_id).toBe("dec-abc");
    expect(resp.risk_level).toBe("medium");
    expect(resp.override_available).toBe(false);
    expect(resp.policy_matches).toHaveLength(1);
    expect(resp.policy_matches?.[0]?.policy_id).toBe("pol-1");
    expect(resp.policy_matches?.[0]?.allow_override).toBe(true);
  });

  it("surfaces richer context on a 403 block + existing override id", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse(403, {
        block_reason: "SQL injection",
        policies_evaluated: 10,
        decision_id: "dec-xyz",
        risk_level: "high",
        override_available: true,
        override_existing_id: "ov-zzz",
        policy_matches: [
          {
            policy_id: "pol-sqli",
            policy_name: "SQL Injection",
            action: "deny",
            risk_level: "high",
            allow_override: true,
          },
        ],
      }),
    );

    const resp = await client.mcpCheckInput("openclaw.Bash", "SELECT", "execute");

    expect(resp.allowed).toBe(false);
    expect(resp.block_reason).toBe("SQL injection");
    expect(resp.decision_id).toBe("dec-xyz");
    expect(resp.override_available).toBe(true);
    expect(resp.override_existing_id).toBe("ov-zzz");
    expect(resp.risk_level).toBe("high");
    expect(resp.policy_matches).toHaveLength(1);
  });

  it("omits richer fields on older platforms that don't return them", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        allowed: true,
        policies_evaluated: 3,
      }),
    );

    const resp = await client.mcpCheckInput("openclaw.Bash", "ls", "execute");

    expect(resp.allowed).toBe(true);
    expect(resp.decision_id).toBeUndefined();
    expect(resp.risk_level).toBeUndefined();
    expect(resp.override_available).toBeUndefined();
    expect(resp.policy_matches).toBeUndefined();
  });

  it("ignores malformed policy_matches entries rather than crashing", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        allowed: true,
        policies_evaluated: 1,
        policy_matches: [null, "not-an-object", { policy_id: "p-1" }],
      }),
    );

    const resp = await client.mcpCheckInput("openclaw.Bash", "ls", "execute");

    expect(resp.policy_matches).toHaveLength(1);
    expect(resp.policy_matches?.[0]?.policy_id).toBe("p-1");
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
