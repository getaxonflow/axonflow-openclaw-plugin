/**
 * The ADR-065 PEP capability handshake, client side
 * (getaxonflow/axonflow-enterprise#3763).
 *
 * The plugin tells the platform WHAT IT CAN DISCHARGE, on every governed call,
 * as a base64url-encoded JSON document in one request header. A platform that
 * would attach a mandatory obligation this plugin has declared it cannot carry
 * out DENIES the request, rather than handing over the content and trusting the
 * plugin to cope (ADR-065 invariant 8).
 *
 * # THIS PLUGIN IS TWO ENFORCEMENT POINTS, AND THAT IS NOT A STYLE CHOICE
 *
 * The design's per-request carrier exists precisely because one process can run
 * two enforcement points with different capabilities behind one credential (the
 * gateway adapters are the case it cites). This plugin is a second such case,
 * and pretending otherwise would be a false declaration:
 *
 *   - The RESPONSE path can discharge a redaction. `MCPCheckOutputResponse`
 *     carries `redacted_data` and `message-guard.ts` substitutes it for the
 *     original content before the model ever sees it.
 *   - The REQUEST path also discharges one, since #192. `mcpCheckInput` reads
 *     `redacted_statement` and the `before_tool_call` handler SUBSTITUTES the
 *     masked text for the caller's parameters before the tool runs, blocking
 *     rather than proceeding if the substitution cannot be applied.
 *
 * Both therefore declare `field_redact@1` today. They remain two documents with
 * two names rather than one shared document, because the capability sets are
 * independent facts about two paths that can diverge again: a future obligation
 * type discharged on one and not the other would otherwise be silently credited
 * to both, and the platform composes a separate identifier for each so an
 * operator can see which path a refusal came from.
 *
 * A declaration must describe what a path CAN do rather than what it should do.
 * The request path's declaration was the EMPTY set until #192 landed, precisely
 * because it could not then perform the substitution.
 *
 * So the two paths present two documents with two names. The platform composes
 * the enforcement point identifier as `client:<credential>:<pep_id>`, so the
 * two are distinguishable in every log line, metric and refusal, while neither
 * can reach outside the namespace the server owns.
 *
 * # ONE BUILDER
 *
 * Both documents come from `encodeHandshake` and both are rendered once at
 * construction. There is no per-call-site encoding and no second copy of the
 * wire shape in this repository.
 *
 * # WHY THIS RE-IMPLEMENTS AN ENCODER THAT EXISTS
 *
 * The canonical encoder is `contract.PEPHandshake.Encode` in a PRIVATE
 * repository this public one cannot import, so this is a hand transcription of
 * a wire format - the drift class that bit five SDKs in
 * axonflow-enterprise#3603. The mitigation is not care: `pep-handshake.test.ts`
 * asserts the exact bytes against vectors captured from the platform's own
 * shipped encoder.
 */

/** The request header a declaration rides on. */
export const PEP_HANDSHAKE_HEADER = "X-Axonflow-PEP-Handshake";

/**
 * The only profile this build emits. The platform matches it with EXACT
 * equality, never as a floor or a range: a build that cannot emit the named
 * profile must not answer as though negotiation succeeded.
 */
const PROFILE_VERSION = 1;

/** The obligation type for engine-fulfilled redaction, and its schema version. */
const CAP_FIELD_REDACT = "field_redact";
const CAP_SCHEMA_V1 = 1;

/**
 * The two enforcement point names, inside the caller's credential namespace.
 *
 * They carry no colon: the platform uses `:` to compose
 * `client:<credential>:<pep_id>`, so admitting one would let a name appear
 * inside an identifier that no string search could tell apart from a real
 * in-process plane.
 */
export const PEP_ID_REQUEST = "openclaw-request";
export const PEP_ID_RESPONSE = "openclaw-response";

/** The platform refuses a header value longer than this. */
const MAX_HANDSHAKE_BYTES = 4096;

/**
 * Bounds the operator-supplied audience before it can reach the wire, so a
 * malformed value fails at construction rather than 400-ing every governed
 * call in production.
 */
const AUDIENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface PepCapability {
  type: string;
  version: number;
}

/**
 * The wire document. EVERY member is required; there is no optional and no
 * defaulted member.
 *
 * `capabilities` in particular must always be serialised. An OMITTED member is
 * MALFORMED to the platform and refuses the request, while `[]` is the
 * legitimate declaration "I discharge nothing". Those are different facts with
 * different outcomes, and collapsing them is the #2958 defect the handshake
 * exists to close.
 */
interface PepHandshakeDoc {
  profile_version: number;
  pep_id: string;
  audience: string;
  capabilities: PepCapability[];
}

/**
 * base64url without padding - the alphabet the platform's own encoder emits.
 *
 * Buffer is available in every runtime this plugin supports (it is a Node
 * plugin), and `base64url` is a documented Node encoding since v14.
 */
function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

/**
 * Renders one declaration as the header value.
 *
 * Throws on an invalid audience or an over-long document rather than returning
 * an empty string: a malformed value that silently disabled the handshake would
 * leave an operator believing a control was in force when it was not.
 */
export function encodeHandshake(
  pepId: string,
  audience: string,
  capabilities: PepCapability[],
): string {
  if (audience.length < 1 || audience.length > 128 || !AUDIENCE_PATTERN.test(audience)) {
    throw new Error(
      `invalid AxonFlow PEP audience ${JSON.stringify(audience)}: ` +
        `1-128 bytes matching ${AUDIENCE_PATTERN}`,
    );
  }

  // Canonical (type, version) order so two installs declaring the same set in a
  // different order send the same bytes. The platform sorts too; agreeing here
  // is what makes the encoding reproducible and the golden vector meaningful.
  const sorted = [...capabilities].sort((a, b) =>
    a.type === b.type ? a.version - b.version : a.type < b.type ? -1 : 1,
  );

  const doc: PepHandshakeDoc = {
    profile_version: PROFILE_VERSION,
    pep_id: pepId,
    audience,
    capabilities: sorted,
  };

  // Member order matters for the byte comparison against the platform's
  // encoder, and an object literal preserves insertion order for string keys.
  const encoded = base64url(JSON.stringify(doc));
  if (encoded.length > MAX_HANDSHAKE_BYTES) {
    throw new Error(
      `the AxonFlow PEP capability handshake encodes to ${encoded.length} bytes; ` +
        `the header carries at most ${MAX_HANDSHAKE_BYTES}`,
    );
  }
  return encoded;
}

/** The two declarations this plugin presents, or undefined when unconfigured. */
export interface PepHandshakes {
  /** Presented on /api/v1/mcp/check-input and the other request-phase calls. */
  request: string;
  /** Presented on /api/v1/mcp/check-output. */
  response: string;
}

/**
 * Builds both declarations, or returns undefined when no audience is
 * configured.
 *
 * # WHY AN AUDIENCE IS REQUIRED RATHER THAN DEFAULTED
 *
 * The audience is what a decision proof gets bound to and only the DEPLOYMENT
 * knows it; a plugin that invented one would assert a binding nobody asked for.
 * It is also why presenting a handshake is opt-in at all: on an Enterprise
 * platform the transition this gates on the REQUEST path is ALLOW -> DENY,
 * because that path cannot substitute a masked statement. Undefined here means
 * no header, and the plugin then behaves byte for byte as it did before.
 *
 * Same variable name and semantics as every other AxonFlow client's knob
 * (`AXONFLOW_PEP_AUDIENCE`), deliberately: one contract across the fleet, no
 * per-client dialects.
 */
export function buildPepHandshakes(audience: string | undefined): PepHandshakes | undefined {
  if (!audience) {
    return undefined;
  }
  return {
    // Since #192 this path receives redacted_statement and substitutes it
    // before the tool runs, so it can discharge the obligation.
    request: encodeHandshake(PEP_ID_REQUEST, audience, [
      { type: CAP_FIELD_REDACT, version: CAP_SCHEMA_V1 },
    ]),
    // The response path substitutes redacted_data in message-guard.ts, so it
    // does discharge the obligation.
    response: encodeHandshake(PEP_ID_RESPONSE, audience, [
      { type: CAP_FIELD_REDACT, version: CAP_SCHEMA_V1 },
    ]),
  };
}
