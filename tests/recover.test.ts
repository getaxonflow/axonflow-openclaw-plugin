/**
 * Unit tests for the W3 free-tier credential-recovery flow.
 *
 * Runtime correctness for the recovery flow (live agent, real magic-link
 * capture file, real persisted file) lives in
 * `runtime-e2e/v1_paid_tier/test.sh`. These unit tests cover the
 * library-level contract: request shape, verify response parsing, token
 * extraction across input shapes, and persist-file shape + permissions.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  requestRecovery,
  verifyRecovery,
  extractRecoveryToken,
  persistRecoveredCredentials,
  RECOVERY_DEFAULT_ENDPOINT,
  type VerifyRecoveryResult,
} from "../src/recover.js";

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  mockFetch.mockReset();
});

function jsonResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

describe("requestRecovery", () => {
  it("posts the email to /api/v1/recover and returns 202 message", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(202, { message: "If this email is registered, check your inbox." }),
    );
    const result = await requestRecovery("alice@example.com", {
      endpoint: "https://example.test",
    });
    expect(result.status).toBe(202);
    expect(result.message).toMatch(/check your inbox/i);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.test/api/v1/recover",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com" }),
      }),
    );
  });

  it("strips trailing slashes from the endpoint", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(202, {}));
    await requestRecovery("a@b.c", { endpoint: "https://example.test///" });
    expect(mockFetch.mock.calls[0]?.[0]).toBe("https://example.test/api/v1/recover");
  });

  it("uses the default endpoint when none is provided", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(202, {}));
    await requestRecovery("a@b.c");
    expect(mockFetch.mock.calls[0]?.[0]).toBe(`${RECOVERY_DEFAULT_ENDPOINT}/api/v1/recover`);
  });

  it("supplies a default message when the body has none (anti-enum default)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(202, {}));
    const result = await requestRecovery("a@b.c");
    expect(result.message).toMatch(/recovery request accepted/i);
  });

  it("rejects empty email", async () => {
    await expect(requestRecovery("")).rejects.toThrow(/email is required/);
    await expect(requestRecovery("   ")).rejects.toThrow(/email is required/);
  });

  it("trims whitespace around the email before posting", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(202, {}));
    await requestRecovery("  alice@example.com  ");
    expect(mockFetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ email: "alice@example.com" }),
    );
  });

  it("throws when the platform returns an unexpected non-202", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    await expect(requestRecovery("a@b.c")).rejects.toThrow(/HTTP 500/);
  });
});

describe("extractRecoveryToken", () => {
  it("returns the bare token when given a hex string", () => {
    expect(extractRecoveryToken("abc123def456")).toBe("abc123def456");
  });

  it("trims whitespace around a bare token", () => {
    expect(extractRecoveryToken("   abc123  ")).toBe("abc123");
  });

  it("extracts the token from the canonical magic-link URL", () => {
    expect(
      extractRecoveryToken(
        "https://try.getaxonflow.com/api/v1/recover/verify?token=abc123def",
      ),
    ).toBe("abc123def");
  });

  it("extracts the token from a URL with extra query params", () => {
    expect(
      extractRecoveryToken("https://try.getaxonflow.com/landing?other=x&token=tok-xyz&extra=y"),
    ).toBe("tok-xyz");
  });

  it("rejects URLs from unrecognized hosts", () => {
    expect(() =>
      extractRecoveryToken("https://evil.com/phishing?token=stolen"),
    ).toThrow(/not a recognized AxonFlow endpoint/);
    expect(() =>
      extractRecoveryToken("http://evil.com/phishing?token=stolen"),
    ).toThrow(/not a recognized AxonFlow endpoint/);
  });

  it("rejects subdomain-suffix attacks", () => {
    expect(() =>
      extractRecoveryToken("https://try.getaxonflow.com.evil.com/?token=stolen"),
    ).toThrow(/not a recognized AxonFlow endpoint/);
  });

  it("rejects unrecognized getaxonflow.com subdomains", () => {
    expect(() =>
      extractRecoveryToken("https://staging.getaxonflow.com/?token=x"),
    ).toThrow(/not a recognized AxonFlow endpoint/);
  });

  it("supports http:// URLs (local dev)", () => {
    expect(extractRecoveryToken("http://localhost:8080/recover/verify?token=local")).toBe(
      "local",
    );
  });

  it("supports getaxonflow.com with port", () => {
    expect(
      extractRecoveryToken("https://try.getaxonflow.com:8443/recover?token=with-port"),
    ).toBe("with-port");
  });

  it("supports 127.0.0.1 with token", () => {
    expect(extractRecoveryToken("http://127.0.0.1:8080/recover?token=ipv4")).toBe("ipv4");
  });

  it("supports IPv6 loopback with token", () => {
    expect(extractRecoveryToken("http://[::1]:8080/recover?token=ipv6")).toBe("ipv6");
  });

  it("rejects empty input", () => {
    expect(() => extractRecoveryToken("")).toThrow(/token .* is required/);
    expect(() => extractRecoveryToken("   ")).toThrow(/token .* is required/);
  });

  it("rejects URLs without a token query parameter", () => {
    expect(() => extractRecoveryToken("https://try.getaxonflow.com/landing")).toThrow(
      /no `token` query parameter/,
    );
  });

  it("rejects malformed URLs", () => {
    expect(() => extractRecoveryToken("https://[malformed")).toThrow(
      /Could not parse magic link/,
    );
  });
});

describe("verifyRecovery", () => {
  const goodBody = {
    tenant_id: "cs_recovered_abc",
    secret: "secret-value-xyz-1234567890",
    secret_prefix: "secret-v",
    expires_at: "2026-08-01T00:00:00Z",
    endpoint: "https://try.getaxonflow.com",
    email: "alice@example.com",
    note: "Credentials valid for 90 days. Re-run recover to refresh.",
  };

  it("posts the token and returns the parsed credentials", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, goodBody));
    const result = await verifyRecovery("magic-token-xyz");
    expect(result.tenant_id).toBe("cs_recovered_abc");
    expect(result.secret).toBe("secret-value-xyz-1234567890");
    expect(result.secret_prefix).toBe("secret-v");
    expect(result.email).toBe("alice@example.com");
    expect(result.note).toBe("Credentials valid for 90 days. Re-run recover to refresh.");
    expect(mockFetch).toHaveBeenCalledWith(
      `${RECOVERY_DEFAULT_ENDPOINT}/api/v1/recover/verify`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "magic-token-xyz" }),
      }),
    );
  });

  it("treats secret_prefix and note as optional", async () => {
    const minimal: Record<string, unknown> = { ...goodBody };
    delete minimal["secret_prefix"];
    delete minimal["note"];
    mockFetch.mockResolvedValueOnce(jsonResponse(200, minimal));
    const result = await verifyRecovery("t");
    expect(result.secret_prefix).toBeUndefined();
    expect(result.note).toBeUndefined();
    expect(result.tenant_id).toBe("cs_recovered_abc");
  });

  it("rejects empty token", async () => {
    await expect(verifyRecovery("")).rejects.toThrow(/token is required/);
  });

  it("translates 401 into a friendly message about used / expired tokens", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(401, { error: "token already consumed" }),
    );
    await expect(verifyRecovery("t")).rejects.toThrow(
      /already have been used or expired/,
    );
  });

  it("surfaces non-401 platform errors verbatim", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(500, { error: "database down" }),
    );
    await expect(verifyRecovery("t")).rejects.toThrow(/database down/);
  });

  it("rejects malformed success bodies (missing required fields)", async () => {
    const bad: Record<string, unknown> = { ...goodBody };
    delete bad["tenant_id"];
    mockFetch.mockResolvedValueOnce(jsonResponse(200, bad));
    await expect(verifyRecovery("t")).rejects.toThrow(/malformed body/);
  });

  it("rejects success bodies with empty-string required fields", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ...goodBody, secret: "" }));
    await expect(verifyRecovery("t")).rejects.toThrow(/malformed body/);
  });
});

describe("persistRecoveredCredentials", () => {
  let tmpDir: string;
  let result: VerifyRecoveryResult;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axonflow-recover-test-"));
    result = {
      tenant_id: "cs_persisted_xyz",
      secret: "persisted-secret-value-987",
      secret_prefix: "persiste",
      expires_at: "2026-08-01T00:00:00Z",
      endpoint: "https://try.getaxonflow.com",
      email: "bob@example.com",
    };
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("writes try-registration.json to the override config dir", () => {
    const written = persistRecoveredCredentials(result, tmpDir);
    expect(written).toBe(path.join(tmpDir, "try-registration.json"));
    expect(fs.existsSync(written)).toBe(true);
  });

  it("persists exactly the shape the bootstrap reader expects", () => {
    const written = persistRecoveredCredentials(result, tmpDir);
    const parsed = JSON.parse(fs.readFileSync(written, "utf8")) as Record<string, unknown>;
    expect(parsed["tenant_id"]).toBe("cs_persisted_xyz");
    expect(parsed["secret"]).toBe("persisted-secret-value-987");
    expect(parsed["expires_at"]).toBe("2026-08-01T00:00:00Z");
    expect(parsed["endpoint"]).toBe("https://try.getaxonflow.com");
    // The bootstrap reader does NOT consume secret_prefix / email / note —
    // those are CLI-display fields. Persisting them would be harmless but
    // adds drift. Confirm we do not persist them.
    expect(parsed["secret_prefix"]).toBeUndefined();
    expect(parsed["email"]).toBeUndefined();
    expect(parsed["note"]).toBeUndefined();
  });

  it("writes the file with mode 0o600 on POSIX", () => {
    if (process.platform === "win32") return; // POSIX-only
    const written = persistRecoveredCredentials(result, tmpDir);
    const stat = fs.statSync(written);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("creates the config dir if it does not exist", () => {
    const nested = path.join(tmpDir, "nested", "axonflow");
    persistRecoveredCredentials(result, nested);
    expect(fs.existsSync(path.join(nested, "try-registration.json"))).toBe(true);
  });

  it("throws when no config dir can be resolved (override empty + env unset)", () => {
    const savedHome = process.env.HOME;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const savedAxon = process.env.AXONFLOW_CONFIG_DIR;
    delete process.env.HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.AXONFLOW_CONFIG_DIR;
    // os.homedir() may still return a non-empty fallback on some platforms;
    // we can only rigorously assert the explicit-empty branch:
    expect(() => persistRecoveredCredentials(result, "")).toThrow(
      /Could not resolve|Could not create or secure/,
    );
    if (savedHome !== undefined) process.env.HOME = savedHome;
    if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedAxon !== undefined) process.env.AXONFLOW_CONFIG_DIR = savedAxon;
  });
});
