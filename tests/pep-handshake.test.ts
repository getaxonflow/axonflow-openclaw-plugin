import {
  PEP_HANDSHAKE_HEADER,
  PEP_ID_REQUEST,
  PEP_ID_RESPONSE,
  buildPepHandshakes,
  encodeHandshake,
} from "../src/pep-handshake";

/**
 * Golden vectors captured from the PLATFORM's own shipped encoder
 * (`contract.PEPHandshake.Encode`, via the axonflow-enterprise runtime-e2e
 * client's `-print-handshake` mode), NOT regenerated from this module's output.
 *
 * THIS IS THE WHOLE ANTI-DRIFT MECHANISM. This repository is public and the
 * wire contract lives in a private one, so `pep-handshake.ts` is a hand
 * transcription of a wire format - exactly the drift class that bit five SDKs
 * in axonflow-enterprise#3603. A test that built its expectation by calling
 * `encodeHandshake` would agree with whatever that function did, including
 * being wrong. These constants are the OTHER implementation's actual output, so
 * the two are compared with each other rather than one with itself.
 */
const GOLDEN_REQUEST =
  "eyJwcm9maWxlX3ZlcnNpb24iOjEsInBlcF9pZCI6Im9wZW5jbGF3LXJlcXVlc3QiLCJhdWRpZW5jZSI6ImF4b25mbG93LWRlY2lzaW9uLXByb29mIiwiY2FwYWJpbGl0aWVzIjpbXX0";
const GOLDEN_RESPONSE =
  "eyJwcm9maWxlX3ZlcnNpb24iOjEsInBlcF9pZCI6Im9wZW5jbGF3LXJlc3BvbnNlIiwiYXVkaWVuY2UiOiJheG9uZmxvdy1kZWNpc2lvbi1wcm9vZiIsImNhcGFiaWxpdGllcyI6W3sidHlwZSI6ImZpZWxkX3JlZGFjdCIsInZlcnNpb24iOjF9XX0";
const AUDIENCE = "axonflow-decision-proof";

describe("the PEP capability handshake", () => {
  it("encodes byte for byte as the platform's own encoder does", () => {
    const hs = buildPepHandshakes(AUDIENCE);
    expect(hs).toBeDefined();
    // A mismatch here is a plugin the platform will refuse in the field.
    expect(hs!.request).toBe(GOLDEN_REQUEST);
    expect(hs!.response).toBe(GOLDEN_RESPONSE);
  });

  it("declares NOTHING on the request path, because that path cannot substitute a masked statement", () => {
    const hs = buildPepHandshakes(AUDIENCE)!;
    const doc = JSON.parse(Buffer.from(hs.request, "base64url").toString("utf8"));

    // MCPCheckInputResponse declares no redacted_statement member, so this
    // path cannot yet receive the platform's masked text and cannot perform
    // the substitution that discharges the obligation (issue #192). Declaring
    // field_redact here would tell the platform to ALLOW the call on the
    // strength of a substitution this path cannot perform; declaring nothing
    // makes it DENY instead.
    expect(doc.capabilities).toEqual([]);
    expect(doc.pep_id).toBe(PEP_ID_REQUEST);
  });

  it("declares field_redact@1 on the response path, which really does substitute", () => {
    const hs = buildPepHandshakes(AUDIENCE)!;
    const doc = JSON.parse(Buffer.from(hs.response, "base64url").toString("utf8"));

    // message-guard.ts returns check.redacted_data in place of the original
    // content, so this path can genuinely discharge the obligation.
    expect(doc.capabilities).toEqual([{ type: "field_redact", version: 1 }]);
    expect(doc.pep_id).toBe(PEP_ID_RESPONSE);
  });

  it("gives the two paths DIFFERENT names, so the platform can tell them apart", () => {
    const hs = buildPepHandshakes(AUDIENCE)!;
    expect(hs.request).not.toBe(hs.response);
    expect(PEP_ID_REQUEST).not.toBe(PEP_ID_RESPONSE);
    // Neither may carry a colon: the platform composes
    // client:<credential>:<pep_id>, and a colon would let a name appear inside
    // an identifier no string search could tell from an in-process plane.
    expect(PEP_ID_REQUEST).not.toContain(":");
    expect(PEP_ID_RESPONSE).not.toContain(":");
  });

  it("serialises an empty declaration as [] and never as an absent member", () => {
    // An OMITTED capabilities member is MALFORMED to the platform and refuses
    // the request; `[]` is a declaration. A single conditional that dropped the
    // member when empty would turn every honest empty declaration into a 400,
    // and the whole-string comparison above would move with it - so this
    // asserts the decoded SHAPE.
    const raw = Buffer.from(buildPepHandshakes(AUDIENCE)!.request, "base64url").toString("utf8");
    expect(raw).toContain('"capabilities":[]');
    expect(JSON.parse(raw)).toHaveProperty("capabilities");
  });

  it("never puts identity or entitlement on the wire", () => {
    // A PEP may declare what it CAN DO. It may not declare who it is, what
    // edition it is, or what its organisation is entitled to - and the platform
    // refuses an unknown member outright.
    for (const encoded of Object.values(buildPepHandshakes(AUDIENCE)!)) {
      const doc = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      expect(Object.keys(doc).sort()).toEqual(
        ["audience", "capabilities", "pep_id", "profile_version"].sort(),
      );
    }
  });

  it("presents nothing at all when no audience is configured", () => {
    // The nothing-changes-by-default arm: unset means no header, and the
    // plugin behaves byte for byte as it did before the handshake existed.
    expect(buildPepHandshakes(undefined)).toBeUndefined();
    expect(buildPepHandshakes("")).toBeUndefined();
  });

  it("throws on a malformed audience rather than silently disabling itself", () => {
    // A value that quietly disabled the handshake would leave an operator
    // believing a control was in force when it was not.
    for (const bad of ["has spaces", "-leading-hyphen", "a".repeat(129), "trailing\n"]) {
      expect(() => encodeHandshake(PEP_ID_REQUEST, bad, [])).toThrow();
    }
  });

  it("sorts capabilities canonically so declaration order cannot change the bytes", () => {
    const a = encodeHandshake("p", AUDIENCE, [
      { type: "immutable_audit", version: 1 },
      { type: "field_redact", version: 1 },
    ]);
    const b = encodeHandshake("p", AUDIENCE, [
      { type: "field_redact", version: 1 },
      { type: "immutable_audit", version: 1 },
    ]);
    expect(a).toBe(b);
  });

  it("names the header exactly as the platform reads it", () => {
    expect(PEP_HANDSHAKE_HEADER).toBe("X-Axonflow-PEP-Handshake");
  });
});

/**
 * The wire half. The tests above assert what the builder PRODUCES; these assert
 * what the client SENDS, which is a different fact and the one a customer's
 * platform actually sees.
 */
describe("the handshake on the wire", () => {
  const mockFetch = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = mockFetch;

  function jsonResponse(body: Record<string, unknown>) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    };
  }

  function makeClient(pepAudience?: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AxonFlowClient } = require("../src/axonflow-client.js");
    return new AxonFlowClient({
      endpoint: "http://localhost:8080",
      clientId: "test-client",
      clientSecret: "test-secret",
      mode: "self-hosted",
      pepAudience,
    });
  }

  function headerFrom(call: number): string | undefined {
    return mockFetch.mock.calls[call]?.[1]?.headers?.[PEP_HANDSHAKE_HEADER];
  }

  beforeEach(() => mockFetch.mockReset());

  it("sends the REQUEST declaration on check-input and the RESPONSE one on check-output", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ allowed: true, policies_evaluated: 1 }));
    const c = makeClient(AUDIENCE);

    await c.mcpCheckInput("openclaw.web_fetch", "{}");
    await c.mcpCheckOutput("openclaw.send_message", "hi");

    // The two paths are two enforcement points and must not present the same
    // document: the platform would otherwise attribute one capability set to
    // both, and the request path would be credited with a substitution it
    // cannot perform.
    expect(headerFrom(0)).toBe(GOLDEN_REQUEST);
    expect(headerFrom(1)).toBe(GOLDEN_RESPONSE);
    expect(headerFrom(0)).not.toBe(headerFrom(1));
  });

  it("sends NO header at all when unconfigured", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ allowed: true, policies_evaluated: 1 }));
    const c = makeClient(undefined);

    await c.mcpCheckInput("openclaw.web_fetch", "{}");

    // Absent, not empty. A PRESENT-but-empty value is MALFORMED to the
    // platform and refuses the request, so an `if (handshake)` guard that was
    // dropped would turn every unconfigured install into a 400.
    const headers = mockFetch.mock.calls[0]?.[1]?.headers ?? {};
    expect(Object.keys(headers)).not.toContain(PEP_HANDSHAKE_HEADER);
  });
});
