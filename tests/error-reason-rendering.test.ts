/**
 * #167 scope 4 / axonflow-enterprise#3062 — render the platform's reason
 * instead of collapsing every failure to `HTTP 401 Unauthorized`.
 *
 * `axonflow_create_override` / `axonflow_revoke_override` return 401 in the
 * default configuration of both Community SaaS and a self-hosted community
 * stack, because the override endpoints need per-user identity and the
 * agent's identity trust gate is off by default since platform 9.9.0. The
 * user was given a bare status line and no way to discover that.
 *
 * The plugin's job is to render whatever the platform sends and to degrade
 * cleanly when it sends nothing. NOTHING here may assume a platform version
 * or a specific message: the tests drive several body shapes, including
 * bodies no current platform emits, plus the absent and malformed cases.
 */

import {
  AxonFlowClient,
  AxonFlowHttpError,
  describeErrorBody,
  redactErrorBody,
} from "../src/axonflow-client.js";
import { buildCreateOverrideTool, buildGetTenantIdTool } from "../src/agent-tools.js";
import type { AxonFlowPluginConfig } from "../src/config.js";
import type { ClientRef } from "../src/client-ref.js";

function config(): AxonFlowPluginConfig {
  return {
    endpoint: "http://localhost:8080",
    clientId: "t",
    clientSecret: "s",
    mode: "self-hosted",
    requestTimeoutMs: 1000,
  } as AxonFlowPluginConfig;
}

/** Minimal Response stand-in whose body is read via text(). */
function textResponse(status: number, statusText: string, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  } as unknown as Response;
}

describe("describeErrorBody", () => {
  it("renders the conventional reason properties, most specific first", () => {
    expect(describeErrorBody({ error: "boom" })).toBe("boom");
    expect(describeErrorBody({ message: "boom" })).toBe("boom");
    expect(describeErrorBody({ reason: "boom" })).toBe("boom");
    expect(describeErrorBody({ detail: "boom" })).toBe("boom");
    expect(describeErrorBody({ error_description: "boom" })).toBe("boom");
    expect(describeErrorBody({ error: "first", message: "second" })).toBe("first");
    // A body shaped by a platform this build has never seen still renders.
    expect(describeErrorBody({ message: "per-user identity is not trusted on this deployment" }))
      .toBe("per-user identity is not trusted on this deployment");
  });

  it("returns empty for bodies that carry no usable reason", () => {
    expect(describeErrorBody({})).toBe("");
    expect(describeErrorBody({ error: "" })).toBe("");
    expect(describeErrorBody({ error: "   " })).toBe("");
    expect(describeErrorBody({ error: 42 })).toBe("");
    expect(describeErrorBody({ code: "UNAUTHENTICATED" })).toBe("");
    expect(describeErrorBody(null)).toBe("");
    expect(describeErrorBody(undefined)).toBe("");
    expect(describeErrorBody("a bare string")).toBe("");
    expect(describeErrorBody([{ error: "nested" }])).toBe("");
  });

  it("collapses whitespace and caps length so an HTML page cannot flood output", () => {
    expect(describeErrorBody({ error: " a\n b\t c " })).toBe("a b c");
    const rendered = describeErrorBody({ error: "y".repeat(2000) });
    expect(rendered.length).toBeLessThanOrEqual(301);
    expect(rendered.endsWith("…")).toBe(true);
  });
});

describe("describeErrorBody credential redaction", () => {
  // Some reverse proxies echo the request into their error page. Every
  // governed request from this client carries Authorization: Basic
  // <clientId:clientSecret>, so the moment we started rendering response
  // bodies an echoing 401 would put live credentials into the agent
  // transcript and the operator's logs.
  it("strips echoed Authorization headers", () => {
    const out = describeErrorBody({
      error: "rejected request: Authorization: Basic dGVuYW50OnN1cGVyLXNlY3JldA== path=/api/v1/mcp/check-input",
    });
    expect(out).not.toContain("dGVuYW50OnN1cGVyLXNlY3JldA==");
    expect(out).toContain("<redacted>");
    expect(out).toContain("path=/api/v1/mcp/check-input");
  });

  it("strips echoed per-user and license tokens", () => {
    const out = describeErrorBody({
      error: "denied X-User-Token: eyJhbGciOiJIUzI1NiJ9.abc.def and X-License-Token: AXON-aaaaaaaaaaaa",
    });
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9.abc.def");
    expect(out).not.toContain("AXON-aaaaaaaaaaaa");
  });

  it("strips a bare bearer credential", () => {
    const out = describeErrorBody({ error: "bad token: Bearer abcdefghijklmnop" });
    expect(out).not.toContain("abcdefghijklmnop");
  });

  it("strips credentials from QUOTED / JSON header dumps", () => {
    // Round-2 review: the first pattern required the header name to be
    // immediately followed by `:`/`=`, so a gateway rendering `req.headers`
    // as JSON defeated it — and X-License-Token / X-User-Token / X-API-Key
    // carry no Basic/Bearer scheme for the fallback to anchor on.
    const SECRETS = [
      "AXON-eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhIn0.SIGNATURE_PART",
      "YWNtZS10ZW5hbnQ6czNjcjN0LWNsaWVudC1zZWNyZXQ=",
      "dGVuYW50OnN1cGVyLXNlY3JldA==",
    ];
    const BODIES = [
      '{"x-user-token":"AXON-eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhIn0.SIGNATURE_PART"}',
      'denied for {"x-license-token": "AXON-eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhIn0.SIGNATURE_PART"}',
      '{"x-api-key":"YWNtZS10ZW5hbnQ6czNjcjN0LWNsaWVudC1zZWNyZXQ="} rejected',
      "rejected: Authorization: Basic dGVuYW50OnN1cGVyLXNlY3JldA== path=/api/v1/mcp/check-input",
      "headers={'authorization': 'Basic dGVuYW50OnN1cGVyLXNlY3JldA=='} upstream=deny",
    ];
    for (const b of BODIES) {
      const out = describeErrorBody({ error: b });
      for (const secret of SECRETS) expect(out).not.toContain(secret);
    }
  });

  it("is linear on a pathological input (no catastrophic backtracking)", () => {
    const started = Date.now();
    describeErrorBody({ error: "authorization: " + "a".repeat(200_000) });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("leaves an ordinary reason untouched", () => {
    expect(describeErrorBody({ error: "per-user identity is not trusted on this deployment" }))
      .toBe("per-user identity is not trusted on this deployment");
  });
});

describe("redactErrorBody — the whole body, not just the reason", () => {
  it("redacts nested strings and credential-named keys", () => {
    const out = redactErrorBody({
      error: "no",
      headers: { authorization: "Basic dGVuYW50OnN1cGVyLXNlY3JldA==" },
      nested: { deep: { "x-user-token": "AXON-eyJhbGciOiJFZERTQSJ9.abc.SIGPART" } },
      arr: ["x-license-token: AXON-eyJhbGciOiJFZERTQSJ9.abc.SIGPART"],
      keep: "ordinary text",
    });
    const rendered = JSON.stringify(out);
    expect(rendered).not.toContain("dGVuYW50OnN1cGVyLXNlY3JldA==");
    expect(rendered).not.toContain("AXON-eyJhbGciOiJFZERTQSJ9.abc.SIGPART");
    expect(rendered).toContain("ordinary text");
  });

  it("passes non-string leaves through and terminates on deep nesting", () => {
    expect(redactErrorBody({ n: 42, b: true, z: null })).toEqual({ n: 42, b: true, z: null });
    let deep: unknown = "authorization: Basic dGVuYW50OnN1cGVyLXNlY3JldA==";
    for (let i = 0; i < 30; i++) deep = { next: deep };
    expect(() => redactErrorBody(deep)).not.toThrow();
  });
});

describe("AxonFlowHttpError message", () => {
  it("appends the platform reason when there is one", () => {
    const e = new AxonFlowHttpError(
      401,
      "Unauthorized",
      { message: "per-user identity is not trusted on this deployment" },
      "create override",
    );
    expect(e.message).toContain("HTTP 401 Unauthorized");
    expect(e.message).toContain("per-user identity is not trusted on this deployment");
  });

  it("is byte-identical to the pre-change message when there is no reason", () => {
    expect(new AxonFlowHttpError(401, "Unauthorized", {}, "create override").message).toBe(
      "AxonFlow create override failed: HTTP 401 Unauthorized",
    );
  });

  it("collapses and truncates a long body on the pre-existing call sites too", () => {
    // Call sites like createOverride/revokeOverride already passed
    // `{ error: <raw text> }`. Their messages are now whitespace-collapsed
    // and capped, where before the full raw body was carried. Deliberate —
    // these strings reach an LLM's context — and pinned here so the change
    // is a decision rather than a surprise.
    const e = new AxonFlowHttpError(
      500,
      "Internal Server Error",
      { error: "line one\n\n   line two " + "z".repeat(1000) },
      "create override",
    );
    expect(e.message).toContain("line one line two");
    expect(e.message.length).toBeLessThan(400);
    expect(e.message.endsWith("…")).toBe(true);
    // The untouched body is still available for anything that needs it.
    expect(String(e.responseBody["error"]).length).toBeGreaterThan(1000);
  });
});

describe("mcpCheckInput / mcpCheckOutput 401 body", () => {
  const originalFetch = globalThis.fetch;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    // Every 401 here trips the client's auth-failure breaker, which warns
    // by design. Silence it so this suite's output stays readable.
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  it("renders a JSON reason body", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      textResponse(401, "Unauthorized", JSON.stringify({ error: "license key expired" })),
    ) as unknown as typeof fetch;
    await expect(new AxonFlowClient(config()).mcpCheckInput("openclaw.bash", "{}"))
      .rejects.toThrow(/license key expired/);
  });

  it("renders a plain-text body from an infra layer", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      textResponse(401, "Unauthorized", "Unauthorized: missing credentials"),
    ) as unknown as typeof fetch;
    await expect(new AxonFlowClient(config()).mcpCheckOutput("openclaw.message_sending", "hi"))
      .rejects.toThrow(/Unauthorized: missing credentials/);
  });

  it("degrades to the bare status line on an empty body", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      textResponse(401, "Unauthorized", ""),
    ) as unknown as typeof fetch;
    await expect(new AxonFlowClient(config()).mcpCheckInput("openclaw.bash", "{}"))
      .rejects.toThrow("AxonFlow check-input failed: HTTP 401 Unauthorized");
  });

  it("degrades gracefully on a malformed body rather than throwing SyntaxError", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      textResponse(401, "Unauthorized", '{"error": "truncated'),
    ) as unknown as typeof fetch;
    // Not a SyntaxError: still the typed AxonFlowHttpError the classifier needs.
    const err = await new AxonFlowClient(config())
      .mcpCheckInput("openclaw.bash", "{}")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AxonFlowHttpError);
    expect((err as AxonFlowHttpError).status).toBe(401);
    expect((err as Error).message).toContain('{"error": "truncated');
  });

  it("degrades when the body cannot be read at all", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: { get: () => null },
      text: async () => {
        throw new Error("stream already consumed");
      },
    } as unknown as Response) as unknown as typeof fetch;
    await expect(new AxonFlowClient(config()).mcpCheckInput("openclaw.bash", "{}"))
      .rejects.toThrow("AxonFlow check-input failed: HTTP 401 Unauthorized");
  });

  it("does not hang forever when the peer stalls the 401 body", async () => {
    // fetchWithTimeout clears its abort timer once the RESPONSE resolves, so
    // an unbounded body read here would wedge before_tool_call — and with it
    // every governed tool call in the session — which is exactly what the
    // fail-open policy exists to prevent.
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: { get: () => null },
      text: () => new Promise<string>(() => { /* never settles */ }),
    } as unknown as Response) as unknown as typeof fetch;
    const cfg = { ...config(), requestTimeoutMs: 50 } as AxonFlowPluginConfig;
    await expect(new AxonFlowClient(cfg).mcpCheckInput("openclaw.bash", "{}"))
      .rejects.toThrow("AxonFlow check-input failed: HTTP 401 Unauthorized");
  }, 5000);

  it("tolerates a response object with no text() method", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: { get: () => null },
    } as unknown as Response) as unknown as typeof fetch;
    await expect(new AxonFlowClient(config()).mcpCheckInput("openclaw.bash", "{}"))
      .rejects.toThrow("AxonFlow check-input failed: HTTP 401 Unauthorized");
  });
});

describe("agent tool error rendering", () => {
  function clientRefRejecting(err: unknown): ClientRef {
    return { current: { createOverride: jest.fn().mockRejectedValue(err) } } as unknown as ClientRef;
  }

  const args = {
    policy_id: "sys_pii_email",
    policy_type: "static",
    override_reason: "testing",
  };

  it("surfaces the platform reason to the agent instead of a bare status line", async () => {
    const tool = buildCreateOverrideTool(
      clientRefRejecting(
        new AxonFlowHttpError(
          401,
          "Unauthorized",
          { error: "per-user identity headers are not trusted on this deployment" },
          "create override",
        ),
      ),
    );
    const res = await tool.execute("c1", args);
    const text = res.content[0]?.text ?? "";
    expect(res.isError).toBe(true);
    expect(text).toContain("HTTP 401 Unauthorized");
    expect(text).toContain("per-user identity headers are not trusted on this deployment");
  });

  it("keeps the bare status line when the platform sends no reason", async () => {
    const tool = buildCreateOverrideTool(
      clientRefRejecting(new AxonFlowHttpError(401, "Unauthorized", {}, "create override")),
    );
    const res = await tool.execute("c2", args);
    expect(res.content[0]?.text).toBe("Error: HTTP 401 Unauthorized");
  });

  it("keeps the body available on details, redacted", async () => {
    const body = { error: "nope", code: "IDENTITY_UNTRUSTED", docs: "https://example/doc" };
    const tool = buildCreateOverrideTool(
      clientRefRejecting(new AxonFlowHttpError(401, "Unauthorized", body, "create override")),
    );
    const res = await tool.execute("c3", args);
    expect((res.details as Record<string, unknown>)["body"]).toEqual(body);
    expect((res.details as Record<string, unknown>)["status"]).toBe(401);
  });

  it("does NOT hand an echoed credential to the model through details", async () => {
    // Round-2 review: the reason was redacted while the raw body went to the
    // model on `details`, which made the protection decorative.
    const body = {
      error: "rejected",
      request: { headers: { authorization: "Basic dGVuYW50OnN1cGVyLXNlY3JldA==" } },
    };
    const tool = buildCreateOverrideTool(
      clientRefRejecting(new AxonFlowHttpError(401, "Unauthorized", body, "create override")),
    );
    const res = await tool.execute("c7", args);
    const rendered = JSON.stringify(res.details);
    expect(rendered).not.toContain("dGVuYW50OnN1cGVyLXNlY3JldA==");
    // ...and the error object itself still carries the raw body for
    // programmatic consumers.
    expect(JSON.stringify(body)).toContain("dGVuYW50OnN1cGVyLXNlY3JldA==");
  });

  it("renders a malformed reason without crashing the tool", async () => {
    const tool = buildCreateOverrideTool(
      clientRefRejecting(
        new AxonFlowHttpError(401, "Unauthorized", { error: { nested: true } } as unknown as Record<string, unknown>, "create override"),
      ),
    );
    const res = await tool.execute("c4", args);
    expect(res.content[0]?.text).toBe("Error: HTTP 401 Unauthorized");
  });

  it("still reports non-HTTP errors by their message", async () => {
    const tool = buildCreateOverrideTool(clientRefRejecting(new Error("fetch failed")));
    const res = await tool.execute("c5", args);
    expect(res.content[0]?.text).toContain("fetch failed");
  });

  it("does not break the tenant-id tool's error path", async () => {
    // buildGetTenantIdTool has no client dependency; smoke the success path
    // so the describeError refactor cannot regress it silently.
    const res = await buildGetTenantIdTool({}).execute("c6", {});
    expect(res.isError).toBeUndefined();
  });
});
