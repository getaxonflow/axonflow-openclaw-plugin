/**
 * #167 defect 2 — a governance plugin that has stopped governing must say so.
 *
 * `before_tool_call` fails OPEN on network errors regardless of
 * `config.onError`. That policy is deliberate and these tests pin that it is
 * UNCHANGED. What they add is the requirement that the fail-open is
 * announced: through v2.8.4 a plugin pointed at a dead endpoint executed
 * governed tool calls with no policy evaluation and no signal at all.
 */

import { createBeforeToolCallHandler } from "../src/governance.js";
import {
  noteNetworkFailOpen,
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

describe("noteNetworkFailOpen", () => {
  it("emits exactly once per process", () => {
    expect(noteNetworkFailOpen(ENDPOINT, new Error("fetch failed"))).toBe(true);
    expect(noteNetworkFailOpen(ENDPOINT, new Error("fetch failed"))).toBe(false);
    expect(noteNetworkFailOpen("http://other:9999", new Error("boom"))).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("names the endpoint, the cause, and that the call was ungoverned", () => {
    noteNetworkFailOpen(ENDPOINT, new Error("connect ECONNREFUSED 127.0.0.1:8080"));
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("[AxonFlow]");
    expect(msg).toContain(ENDPOINT);
    expect(msg).toContain("connect ECONNREFUSED 127.0.0.1:8080");
    expect(msg).toContain("UNGOVERNED");
    expect(msg).toContain("no policy was evaluated");
  });

  it("degrades gracefully on an empty endpoint and a non-Error cause", () => {
    noteNetworkFailOpen("   ", "some string failure");
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("(no endpoint configured)");
    expect(msg).toContain("some string failure");
  });

  it("bounds a pathologically long cause so it cannot flood the transcript", () => {
    noteNetworkFailOpen(ENDPOINT, new Error("x".repeat(5000)));
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg.length).toBeLessThan(700);
    expect(msg).toContain("…");
  });

  it("collapses newlines so the notice stays one line", () => {
    noteNetworkFailOpen(ENDPOINT, new Error("line one\nline two\n\tline three"));
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("line one line two line three");
  });

  it("says something useful when the cause carries no detail", () => {
    noteNetworkFailOpen(ENDPOINT, new Error(""));
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("no error detail available");
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
    // onError=allow makes a 401 proceed ungoverned too, but that is an
    // operator-chosen posture on a path that already emits its own
    // one-shot auth warning from the client. Warning here would double it.
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
});
