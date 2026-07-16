/**
 * Per-user token (X-User-Token) plumbing — axonflow-enterprise#2945,
 * epic #2919. Parity with axonflow-claude-plugin#107.
 *
 * Covers:
 *   - three-source resolution (pluginConfig → env → 0600 file) including the
 *     claude-plugin#108 equivalence contract: a MALFORMED higher-priority
 *     source falls through to a VALID lower-priority one instead of
 *     suppressing it;
 *   - wire-safety gate (malformed ⇒ dropped, never sent);
 *   - 0600 permission enforcement on the provisioning file;
 *   - X-User-Token forwarding on every governed HTTP path, and byte-identical
 *     headers when unconfigured (the v2.6.7 equivalence claim);
 *   - value-free diagnostics: no warning and no init log line ever contains
 *     the token value.
 *
 * Runtime correctness lives in `runtime-e2e/user-token/test.sh` — these unit
 * tests are the additive regression net per FEATURE_RUNTIME_COVERAGE.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AxonFlowClient } from "../src/axonflow-client.js";
import { resolveConfig } from "../src/config.js";
import { registerAxonFlowGovernance } from "../src/index.js";
import {
  resolveUserToken,
  userTokenFilePath,
  userTokenLooksValid,
} from "../src/user-token.js";

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const VALID_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImRldkBleGFtcGxlLmNvbSJ9.c2ln";
const OTHER_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6Im90aGVyQGV4YW1wbGUuY29tIn0.b3Ro";

function jsonResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : `HTTP ${status}`,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
    headers: { get: () => null },
  };
}

/** Temp homedir with an optional provisioning file at the canonical path. */
function makeHome(fileContent?: string, mode: number = 0o600): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "axf-user-token-"));
  if (fileContent !== undefined) {
    const file = userTokenFilePath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, fileContent, { mode });
    fs.chmodSync(file, mode); // umask can strip bits on writeFileSync
  }
  return home;
}

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(jsonResponse(200, { allowed: true }));
  savedEnv["AXONFLOW_USER_TOKEN"] = process.env.AXONFLOW_USER_TOKEN;
  savedEnv["AXONFLOW_LICENSE_TOKEN"] = process.env.AXONFLOW_LICENSE_TOKEN;
  savedEnv["HOME"] = process.env.HOME;
  delete process.env.AXONFLOW_USER_TOKEN;
  delete process.env.AXONFLOW_LICENSE_TOKEN;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// Wire-safety gate
// ---------------------------------------------------------------------------

describe("userTokenLooksValid", () => {
  it("accepts a compact JWT shape", () => {
    expect(userTokenLooksValid(VALID_TOKEN)).toBe(true);
  });

  it("rejects empty, whitespace, control, quote, and backslash candidates", () => {
    expect(userTokenLooksValid("")).toBe(false);
    expect(userTokenLooksValid("abc def")).toBe(false); // interior space
    expect(userTokenLooksValid("abc\ndef")).toBe(false); // newline (header splitting)
    expect(userTokenLooksValid("abc\rdef")).toBe(false); // CR (header splitting)
    expect(userTokenLooksValid("abc\tdef")).toBe(false); // tab
    expect(userTokenLooksValid('abc"def')).toBe(false); // quote (JSON breaking)
    expect(userTokenLooksValid("abc\\def")).toBe(false); // backslash
    expect(userTokenLooksValid("abc\u0007def")).toBe(false); // control byte
    expect(userTokenLooksValid("abc\u007fdef")).toBe(false); // DEL
  });

  it("does not pin the JWT structure (platform owns format evolution)", () => {
    expect(userTokenLooksValid("no-dots-at-all")).toBe(true);
    expect(userTokenLooksValid("four.part.token.shape")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Three-source resolution
// ---------------------------------------------------------------------------

describe("resolveUserToken — source priority", () => {
  it("returns undefined with no warnings when nothing is configured", () => {
    const home = makeHome();
    const res = resolveUserToken(undefined, { env: {}, homedir: home });
    expect(res.token).toBeUndefined();
    expect(res.source).toBeUndefined();
    expect(res.warnings).toEqual([]);
  });

  it("uses pluginConfig.userToken first", () => {
    const home = makeHome(JSON.stringify({ token: OTHER_TOKEN }));
    const res = resolveUserToken(VALID_TOKEN, {
      env: { AXONFLOW_USER_TOKEN: OTHER_TOKEN },
      homedir: home,
    });
    expect(res.token).toBe(VALID_TOKEN);
    expect(res.source).toBe("pluginConfig");
  });

  it("falls back to AXONFLOW_USER_TOKEN env when config is unset", () => {
    const home = makeHome(JSON.stringify({ token: OTHER_TOKEN }));
    const res = resolveUserToken(undefined, {
      env: { AXONFLOW_USER_TOKEN: VALID_TOKEN },
      homedir: home,
    });
    expect(res.token).toBe(VALID_TOKEN);
    expect(res.source).toBe("env");
  });

  it("falls back to the 0600 provisioning file when config + env are unset", () => {
    const home = makeHome(JSON.stringify({ token: VALID_TOKEN }));
    const res = resolveUserToken(undefined, { env: {}, homedir: home });
    expect(res.token).toBe(VALID_TOKEN);
    expect(res.source).toBe("file");
    expect(res.warnings).toEqual([]);
  });

  it("trims surrounding whitespace before validating", () => {
    const res = resolveUserToken(`  ${VALID_TOKEN}\n`, { env: {}, homedir: makeHome() });
    expect(res.token).toBe(VALID_TOKEN);
  });
});

describe("resolveUserToken — #108 equivalence (malformed high-priority falls through)", () => {
  it("malformed config + valid env ⇒ env token used (not suppressed)", () => {
    const res = resolveUserToken("mal formed\ntoken", {
      env: { AXONFLOW_USER_TOKEN: VALID_TOKEN },
      homedir: makeHome(),
    });
    expect(res.token).toBe(VALID_TOKEN);
    expect(res.source).toBe("env");
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("pluginConfig.userToken");
  });

  it("malformed env + valid 0600 file ⇒ file token used (not suppressed)", () => {
    const home = makeHome(JSON.stringify({ token: VALID_TOKEN }));
    const res = resolveUserToken(undefined, {
      env: { AXONFLOW_USER_TOKEN: "mal formed" },
      homedir: home,
    });
    expect(res.token).toBe(VALID_TOKEN);
    expect(res.source).toBe("file");
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("AXONFLOW_USER_TOKEN");
  });

  it("all sources malformed ⇒ dropped entirely (never sent), one warning per source", () => {
    const home = makeHome(JSON.stringify({ token: "also bad" }));
    const res = resolveUserToken('cfg"bad', {
      env: { AXONFLOW_USER_TOKEN: "env bad" },
      homedir: home,
    });
    expect(res.token).toBeUndefined();
    expect(res.warnings).toHaveLength(3);
  });

  it("warnings never contain the candidate values", () => {
    const home = makeHome(JSON.stringify({ token: "file secret-y value" }));
    const res = resolveUserToken("config secret value", {
      env: { AXONFLOW_USER_TOKEN: "env secret value" },
      homedir: home,
    });
    for (const w of res.warnings) {
      expect(w).not.toContain("secret");
    }
  });
});

describe("resolveUserToken — provisioning file handling", () => {
  it("refuses a non-0600 file with a warning (POSIX)", () => {
    if (process.platform === "win32") return;
    const home = makeHome(JSON.stringify({ token: VALID_TOKEN }), 0o644);
    const res = resolveUserToken(undefined, { env: {}, homedir: home });
    expect(res.token).toBeUndefined();
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("unsafe permissions");
    expect(res.warnings[0]).toContain("644");
    expect(res.warnings[0]).not.toContain(VALID_TOKEN);
  });

  it("warns on invalid JSON without leaking file contents", () => {
    const home = makeHome(`not json ${VALID_TOKEN}`);
    const res = resolveUserToken(undefined, { env: {}, homedir: home });
    expect(res.token).toBeUndefined();
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("not valid JSON");
    expect(res.warnings[0]).not.toContain(VALID_TOKEN);
  });

  it("warns on a malformed token inside valid JSON", () => {
    const home = makeHome(JSON.stringify({ token: "has spaces in it" }));
    const res = resolveUserToken(undefined, { env: {}, homedir: home });
    expect(res.token).toBeUndefined();
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("malformed per-user token");
  });

  it("stays silent on a missing file or an empty token field", () => {
    expect(
      resolveUserToken(undefined, { env: {}, homedir: makeHome() }).warnings,
    ).toEqual([]);
    const home = makeHome(JSON.stringify({ token: "" }));
    expect(resolveUserToken(undefined, { env: {}, homedir: home }).warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveConfig integration
// ---------------------------------------------------------------------------

describe("resolveConfig — userToken plumbing", () => {
  it("resolves pluginConfig.userToken onto the config", () => {
    process.env.HOME = makeHome();
    const config = resolveConfig({
      endpoint: "http://localhost:8080",
      userToken: VALID_TOKEN,
    });
    expect(config.userToken).toBe(VALID_TOKEN);
    expect(config.userTokenSource).toBe("pluginConfig");
    expect(config.userTokenWarnings).toBeUndefined();
  });

  it("resolves AXONFLOW_USER_TOKEN env when config key is absent", () => {
    process.env.HOME = makeHome();
    process.env.AXONFLOW_USER_TOKEN = VALID_TOKEN;
    const config = resolveConfig({ endpoint: "http://localhost:8080" });
    expect(config.userToken).toBe(VALID_TOKEN);
    expect(config.userTokenSource).toBe("env");
  });

  it("leaves userToken undefined when nothing is configured", () => {
    process.env.HOME = makeHome();
    const config = resolveConfig({ endpoint: "http://localhost:8080" });
    expect(config.userToken).toBeUndefined();
    expect(config.userTokenSource).toBeUndefined();
    expect(config.userTokenWarnings).toBeUndefined();
  });

  it("attaches value-free warnings for a malformed candidate", () => {
    process.env.HOME = makeHome();
    const config = resolveConfig({
      endpoint: "http://localhost:8080",
      userToken: "mal formed value",
    });
    expect(config.userToken).toBeUndefined();
    expect(config.userTokenWarnings).toHaveLength(1);
    expect(config.userTokenWarnings?.[0]).not.toContain("mal formed value");
  });
});

// ---------------------------------------------------------------------------
// Header forwarding on every governed path
// ---------------------------------------------------------------------------

function makeClient(userToken?: string) {
  return new AxonFlowClient({
    endpoint: "http://localhost:8080",
    clientId: "test-client",
    clientSecret: "test-secret",
    mode: "self-hosted",
    ...(userToken ? { userToken } : {}),
  });
}

function lastRequestHeaders(callIndex = 0): Record<string, string> {
  const call = mockFetch.mock.calls[callIndex];
  return ((call?.[1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
}

describe("X-User-Token forwarding", () => {
  it("includes X-User-Token on mcpCheckInput when configured", async () => {
    await makeClient(VALID_TOKEN).mcpCheckInput("openclaw.web_fetch", "{}");
    expect(lastRequestHeaders()["X-User-Token"]).toBe(VALID_TOKEN);
  });

  it("includes X-User-Token on mcpCheckOutput when configured", async () => {
    await makeClient(VALID_TOKEN).mcpCheckOutput("openclaw.send_message", "hi");
    expect(lastRequestHeaders()["X-User-Token"]).toBe(VALID_TOKEN);
  });

  it("includes X-User-Token on auditToolCall when configured", async () => {
    await makeClient(VALID_TOKEN).auditToolCall("web_fetch", { url: "https://x" });
    expect(lastRequestHeaders()["X-User-Token"]).toBe(VALID_TOKEN);
  });

  it("includes X-User-Token on auditLLMCall when configured", async () => {
    await makeClient(VALID_TOKEN).auditLLMCall(
      "anthropic", "claude", "q", "r",
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, 10,
    );
    expect(lastRequestHeaders()["X-User-Token"]).toBe(VALID_TOKEN);
  });

  it("includes X-User-Token on searchAuditEvents + explainDecision + override lifecycle", async () => {
    const client = makeClient(VALID_TOKEN);
    await client.searchAuditEvents();
    await client.explainDecision("dec-1");
    mockFetch.mockResolvedValue(jsonResponse(200, {
      id: "ov-1", policy_id: "p", policy_type: "static", expires_at: "",
      ttl_seconds: 60, created_at: "",
    }));
    await client.createOverride({
      policyId: "p", policyType: "static", overrideReason: "test",
    });
    await client.revokeOverride("ov-1");
    await client.listOverrides();
    for (let i = 0; i < mockFetch.mock.calls.length; i++) {
      expect(lastRequestHeaders(i)["X-User-Token"]).toBe(VALID_TOKEN);
    }
  });

  it("includes X-User-Token on BOTH callMCPTool steps (initialize + tools/call)", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ...jsonResponse(200, {}),
        headers: { get: (h: string) => (h === "mcp-session-id" ? "sess-1" : null) },
      })
      .mockResolvedValueOnce(jsonResponse(200, {
        result: { content: [{ type: "text", text: "{\"ok\":true}" }] },
      }));
    await makeClient(VALID_TOKEN).callMCPTool("axonflow_audit_search", {});
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(lastRequestHeaders(0)["X-User-Token"]).toBe(VALID_TOKEN);
    expect(lastRequestHeaders(1)["X-User-Token"]).toBe(VALID_TOKEN);
  });

  it("omits the header entirely when unconfigured — headers byte-identical to v2.6.7", async () => {
    await makeClient().mcpCheckInput("openclaw.web_fetch", "{}");
    const headers = lastRequestHeaders();
    expect(Object.keys(headers).sort()).toEqual([
      "Authorization",
      "Content-Type",
      "X-Axonflow-Client",
    ]);
    expect(headers["X-User-Token"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Init canaries + no-leak
// ---------------------------------------------------------------------------

describe("plugin init — per-user token canary + value-free logging", () => {
  function register(pluginConfig: Record<string, unknown>) {
    const lines: string[] = [];
    const capture = (msg: string) => lines.push(msg);
    registerAxonFlowGovernance({
      pluginConfig,
      logger: { info: capture, error: capture, warn: capture },
      on: jest.fn(),
    });
    return lines;
  }

  const BASE = {
    endpoint: "http://localhost:8080",
    clientId: "test",
    clientSecret: "secret",
  };

  it("emits the source-naming canary when a token is configured, without the value", () => {
    const lines = register({ ...BASE, userToken: VALID_TOKEN });
    const canary = lines.find((l) => l.includes("Per-user token configured"));
    expect(canary).toBeDefined();
    expect(canary).toContain("pluginConfig.userToken");
    for (const l of lines) {
      expect(l).not.toContain(VALID_TOKEN);
    }
  });

  it("emits no token line when unconfigured (init output identical to v2.6.7)", () => {
    process.env.HOME = makeHome();
    const lines = register({ ...BASE });
    expect(lines.some((l) => l.includes("Per-user token"))).toBe(false);
  });

  it("surfaces resolution warnings through the host logger, value-free", () => {
    const lines = register({ ...BASE, userToken: "mal formed secret-value" });
    const warning = lines.find((l) => l.includes("pluginConfig.userToken"));
    expect(warning).toBeDefined();
    for (const l of lines) {
      expect(l).not.toContain("secret-value");
    }
  });
});
