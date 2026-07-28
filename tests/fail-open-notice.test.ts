/**
 * #167 defect 2 — a governance plugin that has stopped governing must say so.
 *
 * `before_tool_call` fails OPEN on network errors regardless of
 * `config.onError`. That policy is deliberate and these tests pin that it is
 * UNCHANGED. What they add is the requirement that the fail-open is
 * announced: through v2.8.4 a plugin pointed at a dead endpoint executed
 * governed tool calls with no policy evaluation and no signal at all.
 */

import { createBeforeToolCallHandler, isAxonFlowAuthError } from "../src/governance.js";
import {
  noteUngovernedFailOpen,
  resetFailOpenNoticeForTests,
} from "../src/fail-open-notice.js";
import { AxonFlowHttpError } from "../src/axonflow-client.js";
import type { AxonFlowPluginConfig } from "../src/config.js";
import type { ClientRef } from "../src/client-ref.js";

const ENDPOINT = "http://localhost:8080";

function baseConfig(overrides: Partial<AxonFlowPluginConfig> = {}): AxonFlowPluginConfig {
  return {
    endpoint: ENDPOINT,
    clientId: "test-tenant",
    clientSecret: "",
    mode: "self-hosted",
    onError: "block",
    ...overrides,
  } as AxonFlowPluginConfig;
}

/** ClientRef whose mcpCheckInput always rejects with `err`. */
function throwingClientRef(err: unknown): ClientRef {
  return {
    current: {
      mcpCheckInput: jest.fn().mockRejectedValue(err),
    },
  } as unknown as ClientRef;
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  resetFailOpenNoticeForTests();
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  resetFailOpenNoticeForTests();
});

describe("noteUngovernedFailOpen", () => {
  it("emits exactly once per process", () => {
    expect(noteUngovernedFailOpen(ENDPOINT, new Error("fetch failed"))).toBe(true);
    expect(noteUngovernedFailOpen(ENDPOINT, new Error("fetch failed"))).toBe(false);
    expect(noteUngovernedFailOpen("http://other:9999", new Error("boom"))).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("names the endpoint, the cause, and that the call was ungoverned", () => {
    noteUngovernedFailOpen(ENDPOINT, new Error("connect ECONNREFUSED 127.0.0.1:8080"));
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("[AxonFlow]");
    expect(msg).toContain(ENDPOINT);
    expect(msg).toContain("connect ECONNREFUSED 127.0.0.1:8080");
    expect(msg).toContain("UNGOVERNED");
    expect(msg).toContain("no policy was evaluated");
  });

  it("degrades gracefully on an empty endpoint and a non-Error cause", () => {
    noteUngovernedFailOpen("   ", "some string failure");
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("(no endpoint configured)");
    expect(msg).toContain("some string failure");
  });

  it("bounds a pathologically long cause so it cannot flood the transcript", () => {
    noteUngovernedFailOpen(ENDPOINT, new Error("x".repeat(5000)));
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg.length).toBeLessThan(700);
    expect(msg).toContain("…");
  });

  it("collapses newlines so the notice stays one line", () => {
    noteUngovernedFailOpen(ENDPOINT, new Error("line one\nline two\n\tline three"));
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("line one line two line three");
  });

  it("says something useful when the cause carries no detail", () => {
    noteUngovernedFailOpen(ENDPOINT, new Error(""));
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("no error detail available");
  });
});

describe("a server-supplied reason must not steer the fail-open decision", () => {
  // Round-2 review, BLOCKER. AxonFlowHttpError.message now carries the
  // platform's own reason. isAxonFlowAuthError fell back to regex-matching
  // that message whenever .status was not 401/403, so a transient 5xx whose
  // body happened to mention authentication was classified as an auth error,
  // skipped the fail-open branch, and — under the DEFAULT onError: "block" —
  // hard-blocked every governed tool call while telling the operator to fix
  // credentials that were fine. An ALB answering
  // `502 {"error":"upstream authentication service unavailable"}` is the
  // canonical case. The status now decides in both directions.
  const AUTHY_BODIES = [
    { error: "upstream authentication service unavailable" },
    { message: "gateway timeout contacting the credentials store" },
    { detail: "backend forbidden by upstream policy engine" },
    { reason: "invalid token in the upstream proxy chain" },
  ];

  for (const body of AUTHY_BODIES) {
    const label = Object.values(body)[0];
    it(`treats a 502 as transient despite an auth-shaped reason: "${label}"`, async () => {
      const err = new AxonFlowHttpError(502, "Bad Gateway", body, "check-input");
      expect(isAxonFlowAuthError(err)).toBe(false);

      const handler = createBeforeToolCallHandler(throwingClientRef(err), baseConfig({ onError: "block" }));
      // Fail-OPEN, because it is a network-class failure.
      await expect(handler({ toolName: "bash", params: {} })).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  }

  it("still classifies real 401/403 by status", () => {
    expect(isAxonFlowAuthError(new AxonFlowHttpError(401, "Unauthorized", {}, "x"))).toBe(true);
    expect(isAxonFlowAuthError(new AxonFlowHttpError(403, "Forbidden", {}, "x"))).toBe(true);
    expect(isAxonFlowAuthError(new AxonFlowHttpError(500, "Server Error", {}, "x"))).toBe(false);
    expect(isAxonFlowAuthError(new AxonFlowHttpError(429, "Too Many Requests", {}, "x"))).toBe(false);
  });

  it("still falls back to the message when NO status is exposed", () => {
    // Third-party fetch wrappers and legacy code paths throw plain Errors.
    expect(isAxonFlowAuthError(new Error("HTTP 401 Unauthorized: invalid credentials"))).toBe(true);
    expect(isAxonFlowAuthError(new Error("connect ECONNREFUSED 127.0.0.1:8080"))).toBe(false);
  });
});

describe("before_tool_call network fail-open", () => {
  it("warns once and still allows the tool through (policy unchanged)", async () => {
    const handler = createBeforeToolCallHandler(
      throwingClientRef(new Error("fetch failed")),
      baseConfig(),
    );

    const first = await handler({ toolName: "bash", params: { command: "DROP TABLE users;" } });
    const second = await handler({ toolName: "bash", params: { command: "rm -rf /" } });

    // Fail-open POLICY: both calls proceed. No block, no approval gate.
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    // Notice: announced once for the session, not once per tool call.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain(ENDPOINT);
  });

  it("fails open on a network error even with onError=block", async () => {
    const handler = createBeforeToolCallHandler(
      throwingClientRef(new Error("The operation was aborted")),
      baseConfig({ onError: "block" }),
    );
    await expect(
      handler({ toolName: "bash", params: {} }),
    ).resolves.toBeUndefined();
  });

  it("does NOT warn on an auth error — that path has its own notice", async () => {
    const handler = createBeforeToolCallHandler(
      throwingClientRef(new AxonFlowHttpError(401, "Unauthorized", {}, "check-input")),
      baseConfig({ onError: "block" }),
    );
    const result = await handler({ toolName: "bash", params: {} });

    expect(result?.block).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT warn on an auth error that is configured to fail open", async () => {
    // Pinning the SCOPED behaviour, not an endorsement. This notice is
    // defined as the network-fail-open announcement (#167 DoD: "NOT on auth
    // errors"), so the auth branch is excluded regardless of onError.
    //
    // For a 401 that is harmless — the client's own one-shot auth warning
    // fires from markAuthFailed(). For a 403 it is a real gap: markAuthFailed
    // is called only on status 401, so a 403 under onError=allow proceeds
    // ungoverned and emits nothing at all. Tracked in #170; deliberately NOT
    // widened here because doing so would contradict this change's accepted
    // scope. This test exists so the gap stays visible rather than becoming
    // folklore.
    const handler = createBeforeToolCallHandler(
      throwingClientRef(new AxonFlowHttpError(403, "Forbidden", {}, "check-input")),
      baseConfig({ onError: "allow" }),
    );
    await expect(handler({ toolName: "bash", params: {} })).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when the tool is excluded from governance", async () => {
    const handler = createBeforeToolCallHandler(
      throwingClientRef(new Error("fetch failed")),
      baseConfig({ excludedTools: ["bash"] }),
    );
    await expect(handler({ toolName: "bash", params: {} })).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("names the endpoint the runtime actually resolved", async () => {
    const handler = createBeforeToolCallHandler(
      throwingClientRef(new Error("fetch failed")),
      baseConfig({ endpoint: "https://axonflow.acme.internal" }),
    );
    await handler({ toolName: "bash", params: {} });
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("https://axonflow.acme.internal");
  });

  it("names the endpoint the CLIENT is on, not the pre-bootstrap config value", async () => {
    // In community-saas mode index.ts swaps in a client built on the endpoint
    // the register response named, while the handler still closes over the
    // original config. The notice must follow the client, or it names a host
    // the failing request never touched.
    const ref = throwingClientRef(new Error("fetch failed"));
    (ref.current as unknown as { getEndpoint: () => string }).getEndpoint = () =>
      "https://eu.try.getaxonflow.com";
    const handler = createBeforeToolCallHandler(
      ref,
      baseConfig({ endpoint: "https://try.getaxonflow.com" }),
    );
    await handler({ toolName: "bash", params: {} });
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("https://eu.try.getaxonflow.com");
    expect(msg).not.toContain("https://try.getaxonflow.com (");
  });

  it("falls back to the config endpoint when the client exposes no accessor", async () => {
    const handler = createBeforeToolCallHandler(
      throwingClientRef(new Error("fetch failed")),
      baseConfig({ endpoint: "https://fallback.example" }),
    );
    await handler({ toolName: "bash", params: {} });
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("https://fallback.example");
  });

  it("never lets a throwing console.warn escape the fail-open catch", async () => {
    warnSpy.mockImplementation(() => {
      throw new Error("host console is broken");
    });
    const handler = createBeforeToolCallHandler(
      throwingClientRef(new Error("fetch failed")),
      baseConfig(),
    );
    // Must still fail OPEN — an exception here would convert the fail-open
    // into a rejected hook, the opposite of the policy.
    await expect(handler({ toolName: "bash", params: {} })).resolves.toBeUndefined();
  });
});
