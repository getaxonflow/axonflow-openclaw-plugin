/**
 * Lightweight AxonFlow API client for the plugin.
 *
 * Uses direct HTTP calls to avoid requiring the full @axonflow/sdk
 * as a runtime dependency.
 */

import type { AxonFlowPluginConfig } from "./config.js";
import {
  handleEnvelope as handleV1Envelope,
  isGovernedBackOffActive,
  isThrottleActive,
  TOOL_THROTTLE_FILE,
  type UpgradePromptLogger,
  type V1RateLimitEnvelope,
} from "./upgrade-prompt.js";
import {
  PEP_HANDSHAKE_HEADER,
  buildPepHandshakes,
  type PepHandshakes,
} from "./pep-handshake.js";
import { stripControlCharacters } from "./sanitize-text.js";
import { VERSION } from "./version.js";

/**
 * Property names platforms use to carry a human-readable reason on an error
 * response, most specific first. Probed in order rather than pinned to one
 * key so the plugin renders whatever the deployment it is talking to sends,
 * without assuming a platform version (#167 / axonflow-enterprise#3062: the
 * override endpoints' 401 was collapsed to a bare "HTTP 401 Unauthorized",
 * leaving the user no way to discover that a server-side identity-trust
 * setting governs the feature).
 */
const ERROR_BODY_REASON_KEYS = [
  "error",
  "message",
  "reason",
  "detail",
  "error_description",
] as const;

/**
 * Longest reason rendered into a message. A cap is needed because a proxy can
 * answer with a whole HTML page, and this string reaches an LLM's context.
 *
 * The floor is measured, not guessed. The platform's identity-required 401
 * (axonflow-enterprise#3062 / PR #3069) is **605 characters**, and its own
 * runtime-e2e asserts as a passing gate that the body carries both remedies
 * and the doc reference — which sit at offsets 550 and 583. At the previous
 * 300 the plugin truncated away exactly the half the platform test guarantees:
 * the platform shipped a message engineered to be actionable and this renderer
 * discarded the actionable part, with both CI suites green.
 *
 * 800 clears that message with headroom. The durable guard is the test that
 * pins both remedies surviving (tests/error-reason-rendering.test.ts), not
 * this number — if the platform's message grows past the cap, raise it there
 * and update the fixture rather than trimming the message.
 */
export const MAX_REASON_LENGTH = 800;

/**
 * Credential-shaped content to strip before a server-supplied reason is
 * rendered anywhere a human or a model will read it.
 *
 * Some reverse proxies and debug endpoints echo the request back in their
 * error page. On this client every governed request carries
 * `Authorization: Basic <clientId:clientSecret>` and may carry
 * `X-License-Token` / `X-User-Token`, so an echoing 401 page would otherwise
 * put live credentials into the agent transcript and the operator's logs the
 * moment we started rendering response bodies.
 */
const CREDENTIAL_ECHO_PATTERN =
  // Header form first. Two things it must tolerate, both seen in real proxy
  // error bodies: the value may be quoted (a gateway rendering `req.headers`
  // as JSON), and it may carry a `Basic`/`Bearer` scheme token before the
  // credential. The tokens this client sends — X-License-Token, X-User-Token,
  // X-API-Key — carry no scheme at all, so a scheme-anchored pattern alone
  // leaks them. The value run stops at a quote, comma, semicolon or brace so
  // one header does not swallow the rest of a JSON object. The trailing
  // alternative catches a bare `Basic <b64>` / `Bearer <token>` that appears
  // without its header name — the shape left over once an object walk has
  // already split key from value. Its lookahead spares prose such as
  // "Basic authentication is required" — a plausible real 401 body that the
  // unguarded form mangled into a redacted fragment.
  /\b(?:authorization|proxy-authorization|x-license-token|x-user-token|x-api-key|api[_-]?key)\b["']?\s*[:=]\s*["']?(?:basic|bearer)?\s*[^"',;}\s]+|\b(?:basic|bearer)\s+(?!(?:auth|authentication|authorization|credentials?|token|access)\b)[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Extract a human-readable reason from a platform error body.
 *
 * Returns "" when the body carries nothing usable — an empty object, a
 * non-object, or only non-string values — so callers fall back to the bare
 * status line. Whitespace is collapsed and the result is length-capped: the
 * reason is rendered into agent-visible text, and an unreachable-through-a-
 * proxy call can answer with an HTML error page rather than JSON.
 */
export function describeErrorBody(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const record = body as Record<string, unknown>;
  for (const key of ERROR_BODY_REASON_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const collapsed = stripControlCharacters(value)
      .replace(/\s+/g, " ")
      .replace(CREDENTIAL_ECHO_PATTERN, "<redacted>")
      .trim();
    if (collapsed === "") continue;
    return collapsed.length > MAX_REASON_LENGTH
      ? collapsed.slice(0, MAX_REASON_LENGTH) + "…"
      : collapsed;
  }
  return "";
}

/** How deep {@link redactErrorBody} walks before truncating a body. */
const MAX_REDACTION_DEPTH = 6;

/**
 * Object keys whose VALUE is a credential regardless of the value's shape.
 * Anchored (no `g` flag) so `.test()` carries no `lastIndex` state.
 */
const CREDENTIAL_KEY_PATTERN =
  /^(?:authorization|proxy-authorization|x-license-token|x-user-token|x-api-key|api[_-]?key|secret|client_?secret|password|token)$/i;

/**
 * Apply {@link describeErrorBody}'s credential redaction to EVERY string in an
 * error body, so a caller that forwards the whole body — not just the
 * extracted reason — cannot leak what the reason path strips.
 *
 * `AxonFlowHttpError.responseBody` deliberately stays raw for programmatic
 * use; this is applied at the boundaries where the body reaches a model or a
 * human (see `describeError` in src/agent-tools.ts). Nested objects and
 * arrays are walked; non-string leaves pass through untouched.
 */
export function redactErrorBody(body: unknown, depth = 0): unknown {
  if (typeof body === "string") {
    return stripControlCharacters(body).replace(CREDENTIAL_ECHO_PATTERN, "<redacted>");
  }
  if (body === null || typeof body !== "object") return body;
  // Past the depth limit, DROP the subtree rather than returning it by
  // reference: handing back an unwalked branch would make the limit a
  // redaction bypass — a credential nested one level deeper than the cap
  // would reach the model untouched — instead of a safe truncation. Also
  // terminates on a self-referencing body.
  if (depth >= MAX_REDACTION_DEPTH) return "<redacted: nesting limit>";
  if (Array.isArray(body)) return body.map((v) => redactErrorBody(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    // Redact on the KEY as well as the value. Once a body is walked as an
    // object, the value of a credential-named key is a bare token with no
    // header name left in it for the pattern to anchor on — the exact shape
    // a gateway produces when it renders `req.headers` as JSON.
    const redacted = CREDENTIAL_KEY_PATTERN.test(k)
      ? "<redacted>"
      : redactErrorBody(v, depth + 1);
    // Plain assignment on a server-controlled `__proto__` key would set the
    // output's prototype instead of creating an own property, silently
    // dropping the entry from the rendered body.
    Object.defineProperty(out, k, {
      value: redacted,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Read a non-2xx response body into the `responseBody` shape
 * `AxonFlowHttpError` carries, tolerating every wire form a deployment can
 * answer with: JSON object, JSON scalar/array, plain text from an ALB /
 * nginx / WAF, or nothing at all.
 *
 * Never throws and never rejects — an unreadable body degrades to `{}`, which
 * renders as the bare status line. Callers must not read the body again.
 */
async function readErrorBody(
  response: Response,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  if (typeof response.text !== "function") {
    // A Response always has text(); a test double may expose only json().
    if (typeof response.json !== "function") return {};
    try {
      const parsed: unknown = await response.json();
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  let text: string;
  try {
    // `fetchWithTimeout` clears its abort timer once the RESPONSE resolves,
    // so the body read that follows is unbounded. On the governance hot path
    // a peer that returns 401 headers and then stalls the body would hang
    // `before_tool_call` forever — wedging every governed tool call in the
    // session, the exact outcome the fail-open policy exists to prevent.
    // Bound it independently and abandon the body rather than wait.
    text = await Promise.race([
      response.text(),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve(""), Math.max(1, timeoutMs)).unref?.();
      }),
    ]);
  } catch {
    return {};
  }
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed === "") return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON — fall through and surface the raw text as the reason.
  }
  return { error: trimmed };
}

/**
 * Typed error thrown by the AxonFlow client on non-2xx HTTP responses (a
 * 403 carrying the platform's decision is returned as the deny instead).
 *
 * Exposes `.status` as a dedicated field so downstream consumers —
 * specifically the `isAxonFlowAuthError` classifier in `governance.ts` —
 * can reliably check the HTTP status instead of pattern-matching the
 * error message string. Previously the client threw a plain `Error`
 * with the status number embedded in the message, which forced the
 * classifier to use fragile substring matching.
 *
 * The message carries the platform's own reason when the body supplies one
 * (#167) — extracted, credential-redacted and length-capped by
 * `describeErrorBody`. The untouched body stays on `responseBody`.
 */
export class AxonFlowHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly responseBody: Record<string, unknown>;

  constructor(
    status: number,
    statusText: string,
    responseBody: Record<string, unknown>,
    context: string,
  ) {
    const serverError = describeErrorBody(responseBody);
    super(`AxonFlow ${context} failed: HTTP ${status} ${statusText}${serverError ? " — " + serverError : ""}`);
    this.name = "AxonFlowHttpError";
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
    // Preserve prototype chain for instanceof checks across module boundaries.
    Object.setPrototypeOf(this, AxonFlowHttpError.prototype);
  }
}

/**
 * A governed check refused because a request limit was reached: an HTTP 429,
 * a V1 limit envelope (on a 429 or a 403), or the back-off deadline an earlier
 * limit stamped (#196). Its own class so governance.ts reads it as the limit
 * row of the posture table: a 403 carrying an envelope is a limit, not a
 * credential failure, and the back-off short-circuit sends no request at all.
 */
export class AxonFlowLimitError extends AxonFlowHttpError {
  readonly limitType: string | undefined;

  constructor(
    status: number,
    statusText: string,
    responseBody: Record<string, unknown>,
    context: string,
    limitType?: string,
  ) {
    super(status, statusText, responseBody, context);
    this.name = "AxonFlowLimitError";
    this.limitType = limitType;
    Object.setPrototypeOf(this, AxonFlowLimitError.prototype);
  }
}

/**
 * Whether a refused check's body carries the platform's decision. The
 * check-input and check-output routes answer a policy deny as HTTP 403 with
 * `allowed: false` and a `block_reason` (measured on AxonFlow v11.0.0). A 403
 * with neither, such as a proxy's refusal or a bare `{"error": "..."}`, is
 * not a decision (#196).
 */
function isDecisionBody(body: Record<string, unknown>): boolean {
  return body["allowed"] === false || typeof body["block_reason"] === "string";
}

export interface MCPCheckInputResponse {
  allowed: boolean;
  block_reason?: string;
  policies_evaluated: number;
  /**
   * The engine-masked statement, when an allowed statement carried PII under a
   * redact-not-block policy (ADR-056 / platform #2563).
   *
   * ADR-056 forbids a client from redacting for itself, so substituting this
   * text for the original is the ONLY sanctioned way to discharge a
   * field_redact obligation. It is consumed in governance.ts's
   * before_tool_call handler; see #192.
   */
  redacted_statement?: string;
  /**
   * Whether the redaction detector actually RAN, regardless of whether it
   * masked anything.
   *
   * Load bearing and NOT the same as `redacted_statement === undefined`. The
   * platform's contract (#2563 B1) is that a consumer MUST fail closed when
   * this is false or absent, because "no masked text" is then indistinguishable
   * from "the redactor never looked" - and treating the second as the first is
   * how unmasked content proceeds under the belief that it was checked.
   */
  redaction_evaluated?: boolean;
  /**
   * Whether the engine masked any PII in the request statement (spec:
   * MCPCheckInputResponse.redacted, platform 8.6.0+). Omitted when nothing
   * was redacted. Declared so the wire type matches the v10.4.0 agent spec;
   * governance.ts keys on `redacted_statement` + `redaction_evaluated`, not on
   * this flag.
   */
  redacted?: boolean;
  // Plugin Batch 1 (ADR-042 + ADR-043): richer approval context surfaced
  // when the platform is v7.1.0+. All fields are optional — older
  // platforms return undefined and callers treat the absence as
  // "context not available" rather than an error.
  decision_id?: string;
  policy_matches?: ExplainPolicy[];
  risk_level?: string;
  override_available?: boolean;
  override_existing_id?: string;
}

export interface MCPCheckOutputResponse {
  allowed: boolean;
  block_reason?: string;
  redacted_data?: unknown;
  /**
   * Whether the response redactor RAN (spec: MCPCheckOutputResponse.
   * redaction_evaluated). Absent-or-false means "never looked", which is not
   * "found nothing" (#2563 B1) - the same rule governance.ts applies on the
   * request path.
   */
  redaction_evaluated?: boolean;
  policies_evaluated: number;
  decision_id?: string;
  // `policy_matches` was declared here against the April 2026 spec; the REST
  // check-output response no longer carries it (v10.4.0 agent spec) and this
  // plugin only ever read it from check-input (governance.ts
  // formatRicherContext takes an MCPCheckInputResponse).
}

// ADR-043: Explainability payload shape (frozen).
export interface ExplainPolicy {
  policy_id: string;
  policy_name?: string;
  action?: string;
  risk_level?: string;
  allow_override?: boolean;
  policy_description?: string;
}

export interface ExplainRule {
  policy_id: string;
  rule_id?: string;
  rule_text?: string;
  matched_on?: string;
}

export interface DecisionExplanation {
  decision_id: string;
  timestamp: string;
  policy_matches: ExplainPolicy[];
  matched_rules?: ExplainRule[];
  decision: string;
  reason: string;
  risk_level?: string;
  override_available: boolean;
  override_existing_id?: string;
  historical_hit_count_session: number;
  policy_source_link?: string;
  tool_signature?: string;
}

/**
 * Extract the Plugin Batch 1 (ADR-042 + ADR-043) richer governance context
 * from a policy-check response. All fields are optional — older platforms
 * (pre-v7.1.0) return undefined for every field, and callers treat absence
 * as "context not available" rather than an error.
 *
 * Reviewer-caught regression: without this, the extended MCPCheckInputResponse
 * / MCPCheckOutputResponse fields were declared but never populated, so
 * governance.ts couldn't surface the richer reasoning even when the platform
 * returned it.
 */
/**
 * Type guard for the per-plugin map shape returned under
 * `plugin_compatibility.min_plugin_version` and `recommended_plugin_version`.
 * The platform sends `{ openclaw: "1.3.2", claude: "0.5.2", ... }` — every
 * key and value must be a string for the map to be useful for comparison.
 */
function isStringMap(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== "string") return false;
  }
  return true;
}

function extractRicherContext(data: Record<string, unknown>): {
  decision_id?: string;
  policy_matches?: ExplainPolicy[];
  risk_level?: string;
  override_available?: boolean;
  override_existing_id?: string;
} {
  const ctx: {
    decision_id?: string;
    policy_matches?: ExplainPolicy[];
    risk_level?: string;
    override_available?: boolean;
    override_existing_id?: string;
  } = {};

  if (typeof data["decision_id"] === "string" && data["decision_id"]) {
    ctx.decision_id = data["decision_id"] as string;
  }
  if (typeof data["risk_level"] === "string" && data["risk_level"]) {
    ctx.risk_level = data["risk_level"] as string;
  }
  if (typeof data["override_available"] === "boolean") {
    ctx.override_available = data["override_available"] as boolean;
  }
  if (typeof data["override_existing_id"] === "string" && data["override_existing_id"]) {
    ctx.override_existing_id = data["override_existing_id"] as string;
  }

  const rawMatches = data["policy_matches"];
  if (Array.isArray(rawMatches)) {
    ctx.policy_matches = rawMatches
      .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
      .map((m) => ({
        policy_id: typeof m["policy_id"] === "string" ? (m["policy_id"] as string) : "",
        policy_name: typeof m["policy_name"] === "string" ? (m["policy_name"] as string) : undefined,
        action: typeof m["action"] === "string" ? (m["action"] as string) : undefined,
        risk_level: typeof m["risk_level"] === "string" ? (m["risk_level"] as string) : undefined,
        allow_override:
          typeof m["allow_override"] === "boolean" ? (m["allow_override"] as boolean) : undefined,
        policy_description:
          typeof m["policy_description"] === "string"
            ? (m["policy_description"] as string)
            : undefined,
      }));
  }

  return ctx;
}

/**
 * Extract policies_evaluated count from API response.
 * The platform returns this as a top-level number on 403 responses,
 * or inside policy_info.policies_evaluated (which can be a number or
 * array of policy names) on 200 responses.
 */
/**
 * The block reason for a 2xx check answer that is a JSON object without a
 * boolean `allowed` (#196). It carries no decision, so it is blocked (the
 * no-decision ruling of 2026-09-14), with a reason that says so rather than
 * reading as a policy deny.
 */
export const NO_DECISION_REASON =
  'AxonFlow answered the governance check without a decision (no boolean "allowed"), so it is blocked';

function noDecision(data: Record<string, unknown>): {
  allowed: false;
  block_reason: string;
  policies_evaluated: number;
} {
  return {
    allowed: false,
    block_reason: NO_DECISION_REASON,
    policies_evaluated: extractPoliciesEvaluated(data),
  };
}

function extractPoliciesEvaluated(data: Record<string, unknown>): number {
  if (typeof data["policies_evaluated"] === "number") {
    return data["policies_evaluated"];
  }
  const policyInfo = data["policy_info"];
  if (typeof policyInfo === "object" && policyInfo !== null) {
    const pi = policyInfo as Record<string, unknown>;
    if (typeof pi["policies_evaluated"] === "number") {
      return pi["policies_evaluated"];
    }
    if (Array.isArray(pi["policies_evaluated"])) {
      return pi["policies_evaluated"].length;
    }
  }
  return 0;
}

/**
 * Drop-on-the-floor logger used when the host hasn't wired its own.
 * Keeps the envelope detection + throttle-stamp side effects firing
 * regardless of whether the operator gets to see the upgrade wording.
 */
const noopUpgradePromptLogger: UpgradePromptLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function truncateStringValues(obj: Record<string, unknown>, maxLen: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "string" && v.length > maxLen ? v.slice(0, maxLen) + "…" : v;
  }
  return out;
}

export class AxonFlowClient {
  private readonly endpoint: string;
  private readonly authHeader: string;
  private readonly requestTimeoutMs: number;
  private readonly userEmail: string | undefined;
  private readonly licenseToken: string | undefined;
  private readonly userToken: string | undefined;
  private readonly clientHeader: string;
  /**
   * The ADR-065 capability declarations, rendered ONCE at construction, or
   * undefined when no audience is configured (the default, which sends no
   * header and changes nothing).
   *
   * Two documents rather than one because this plugin is two enforcement
   * points with different capabilities; see src/pep-handshake.ts for why
   * declaring one set for both would be a false declaration on the request
   * path.
   */
  private readonly pepHandshakes: PepHandshakes | undefined;
  // V1 Plugin Pro upgrade-prompt sink — populated via setUpgradePromptLogger.
  // When set, V1 envelope detections on 429 / 403 surface the locked
  // wording + buy URL via this logger and stamp a throttle deadline so
  // subsequent governed calls can short-circuit locally.
  private upgradePromptLogger: UpgradePromptLogger | null = null;
  // Issue #2275 — process-local 401 circuit breaker.
  //
  // Symptom: 716 × HTTP 401 in 24 hours against /api/v1/audit/tool-call
  // from a single source IP with User-Agent "node". Root cause: the
  // fire-and-forget audit methods (auditToolCall / auditLLMCall) silently
  // swallow ALL errors, so a misconfigured-credentials install keeps
  // firing audit POSTs on every tool execution. Over a long-lived
  // OpenClaw process this multiplies into hundreds of 401s/day.
  //
  // Fix: once a tenant-credential route observes a 401, flip the flag and
  // short-circuit every subsequent governed/audit call without round-
  // tripping. Process-local — a new AxonFlowClient instance (e.g. after
  // config reload) starts fresh.
  //
  // Only the tenant-credential routes arm it (#196): check-input,
  // check-output and the tool-call audit. A 401 there is the tenant
  // credential failing. A 401 on any other route is an identity refusal or
  // that route's own posture (the override writes answer 401 to a caller
  // with no per-user identity), and it never locks the governed routes; see
  // fetchWithTimeout. mcpCheckInput / mcpCheckOutput detect 401 BEFORE
  // reading the body so a non-JSON 401 (text/plain from ALB / nginx / WAF /
  // API Gateway) keeps the typed-error contract.
  private authFailed: boolean = false;
  // Companion to authFailed — guards `console.warn` so the operator sees
  // the failure exactly once per process lifetime, even if multiple
  // methods cross the 401 boundary concurrently.
  private authWarningEmitted: boolean = false;
  // One MCP session reused across agent-tool calls (#196). The platform counts
  // `initialize` and `tools/call` against the per-minute request limit, so a
  // fresh session per call spent two requests. A platform session keeps the
  // identity it was created with, so a revoked X-User-Token keeps reaching the
  // agent tools for as long as the session is reused: MCP_SESSION_MAX_AGE_MS
  // bounds that, and any answer that is not a clean result drops the session.
  // The governed routes (check-input / check-output) use no MCP session.
  private mcpSession: { id: string; createdAtMs: number } | null = null;
  /** How long a cached MCP session is reused before a new one is initialized. */
  static readonly MCP_SESSION_MAX_AGE_MS = 5 * 60 * 1000;
  constructor(config: AxonFlowPluginConfig) {
    // Strip trailing slashes without regex (avoids ReDoS on polynomial patterns)
    let ep = config.endpoint;
    while (ep.endsWith("/")) ep = ep.slice(0, -1);
    this.endpoint = ep;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 8000;
    const credentials = Buffer.from(
      `${config.clientId}:${config.clientSecret}`,
    ).toString("base64");
    this.authHeader = `Basic ${credentials}`;
    // Store per-user identity for Plugin Batch 1 endpoints — listOverrides
    // requires it, and explain's historical_hit_count scope depends on it.
    this.userEmail = config.userEmail && config.userEmail.trim()
      ? config.userEmail.trim()
      : undefined;
    // W4 paid Pro v1: when a plugin-claim license token is configured, the
    // plugin forwards it on every governed request via X-License-Token. The
    // agent's PluginClaimMiddleware (PR #1847) validates it, looks up the
    // row in plugin_user_licenses, and enriches the request context with
    // Pro-tier entitlements (retention, quotas, capabilities). Plugin does
    // no client-side validation — a malformed token surfaces as the agent's
    // normal 401 / 503 path. Free-tier installs leave this unset and the
    // header is omitted entirely so the middleware short-circuits to
    // "absent" with zero added cost.
    this.licenseToken = config.licenseToken && config.licenseToken.trim()
      ? config.licenseToken.trim()
      : undefined;
    // #2945 per-user token: resolved + wire-safety-validated upstream in
    // resolveConfig (src/user-token.ts); a malformed candidate never reaches
    // this constructor. When set, every governed request carries it as
    // X-User-Token so the platform's fleet plane can resolve a VALIDATED
    // {identity, role} for the developer (vs the forgeable X-User-Email
    // label). When unset, the header is omitted entirely — requests are
    // byte-identical to v2.6.7 and the platform keeps its existing
    // least-privilege attribution path.
    this.userToken = config.userToken && config.userToken.trim()
      ? config.userToken.trim()
      : undefined;
    // ADR-050 §4: every governed request carries X-Axonflow-Client so the
    // agent can derive request scope (plugin/sdk/full) and validate it
    // against the token's aud.scope. Computed once at construction; never
    // sourced from config or env (the consumer doesn't get to spoof its
    // own client identity to the agent).
    this.clientHeader = `openclaw/${VERSION}`;
    // Built at construction so a malformed audience fails here rather than
    // 400-ing every governed call in production.
    this.pepHandshakes = buildPepHandshakes(config.pepAudience);
  }

  /**
   * Configure the sink for V1 Plugin Pro upgrade-prompt envelopes.
   * When the agent returns a 429 (daily-quota) or 403 (graduated /
   * Pro-only) with a structured envelope, the wording + buy URL are
   * forwarded to this logger (gated to once-per-UTC-day).
   *
   * Call from index.ts during plugin init:
   *   client.setUpgradePromptLogger(api.logger).
   *
   * Optional — when unset, the client still detects + stamps the
   * throttle so subsequent calls back off, but no wording is surfaced.
   */
  setUpgradePromptLogger(logger: UpgradePromptLogger | null): void {
    this.upgradePromptLogger = logger;
  }

  /**
   * The endpoint THIS client instance sends to, trailing slashes stripped.
   *
   * Callers that report an endpoint to the user must read it from here
   * rather than from the config they were constructed with: in
   * community-saas mode `registerAxonFlowGovernance` swaps in a new client
   * built on the endpoint the register response named, so the two can
   * differ. Same rule as the status surface — display what the runtime
   * uses, never a parallel value (#167).
   */
  getEndpoint(): string {
    return this.endpoint;
  }

  /**
   * Internal helper: detect + handle a V1 envelope on a non-2xx
   * response. Returns the parsed envelope (so the caller can decide
   * how to surface it through its existing return shape) or null if
   * the response is not envelope-bearing. `stampFile` names the back-off
   * file: the default (throttle-until) only for check-input and
   * check-output, TOOL_THROTTLE_FILE for every other surface, so a limit
   * there never gates a governed tool call (#196).
   *
   * Runs whether or not a logger is wired — without a logger the
   * envelope is still detected and the throttle deadline is still
   * stamped (so subsequent calls short-circuit), the wording just
   * drops on the floor instead of landing on the operator-visible
   * channel.
   */
  private handleEnvelope(
    status: number,
    body: unknown,
    response: Response,
    stampFile?: string,
  ): V1RateLimitEnvelope | null {
    // Three envelope-bearing paths today: 429 (apiAuthMiddleware
    // daily-quota), 403 (REST graduated cap / Pro-only), and HTTP 200
    // with JSON-RPC `result.isError = true` (the MCP tools/call gate
    // path, exercised by the V1 Pro proxy tools — see callMCPTool).
    // The full status-vs-shape decision lives in handleV1Envelope so
    // we don't pre-filter here; this wrapper just resolves headers
    // safely against header-less mock Response objects in unit tests.
    const retryAfterHeader = typeof response.headers?.get === "function"
      ? response.headers.get("retry-after")
      : null;
    const result = handleV1Envelope({
      status,
      body,
      retryAfterHeader,
      logger: this.upgradePromptLogger ?? noopUpgradePromptLogger,
      stampFile,
    });
    return result.envelope ?? null;
  }

  /**
   * Issue #2275 — process-local auth-failure circuit breaker.
   *
   * Returns true once a tenant-credential route (check-input, check-output,
   * or the tool-call audit auditToolCall and auditLLMCall post to) has
   * answered HTTP 401. Test-only / introspection helper; production callers
   * do NOT need to branch on this — those entry points consult the private
   * `authFailed` flag directly and short-circuit BEFORE issuing the network
   * call. See `fetchWithTimeout` for why no other route arms it.
   */
  isAuthFailed(): boolean {
    return this.authFailed;
  }

  /**
   * Issue #2275 — flip the circuit breaker.
   *
   * Called when a tenant-credential route answers HTTP 401 (see
   * `fetchWithTimeout`). Idempotent: only emits the operator-visible warning the
   * first time it's invoked per process lifetime (guarded by the
   * companion `authWarningEmitted` flag). Concurrent 401s from sibling
   * methods all land in the same single warn — both the flag-set and
   * the warn-emit are synchronous and not awaited, so they're race-free
   * inside Node's single-threaded event loop.
   */
  private markAuthFailed(): void {
    this.authFailed = true;
    if (!this.authWarningEmitted) {
      this.authWarningEmitted = true;
      // #2945: when a per-user token is configured, a revoked/expired/
      // tampered X-User-Token is the most likely 401 cause (the platform
      // fails closed on a presented-but-invalid token) — point the operator
      // at re-provisioning it, not just the tenant credentials. Value-free:
      // names the mechanism, never the token.
      const tokenHint = this.userToken
        ? " A per-user token is configured — if it was revoked or expired, re-provision it (pluginConfig.userToken / AXONFLOW_USER_TOKEN / ~/.config/axonflow/user-token.json)."
        : "";
      console.warn(
        "[AxonFlow] Authentication failed (HTTP 401). Governance checks and audit calls are " +
          "disabled for the rest of this session: with onError=block every governed tool call " +
          "is denied, with onError=allow every governed tool call runs UNGOVERNED. " +
          `Refresh credentials via the OpenClaw runtime config.${tokenHint}`,
      );
    }
  }

  /**
   * @param handshake - the ADR-065 capability declaration for THIS call path,
   *   or undefined. Passed per call site rather than read from a field because
   *   this plugin is TWO enforcement points: the response path can substitute a
   *   masked statement and the request path cannot, so they declare different
   *   capability sets under different names. See src/pep-handshake.ts.
   */
  private baseHeaders(handshake?: string): Record<string, string> {
    // Tenant is derived from Basic auth credentials on the server side (RFC 6749).
    // X-Tenant-ID header is no longer sent — server knows tenant from auth.
    //
    // Plugin Batch 1 (ADR-044): forward X-User-Email when configured so the
    // orchestrator can scope override ownership and explain access control
    // by real caller rather than by a synthetic client-wide identity.
    //
    // W4 paid Pro v1 (ADR-049): forward X-License-Token when a plugin-claim
    // token is configured so the agent middleware can apply tier-aware
    // entitlements (retention, quotas, capabilities). Header is omitted on
    // free-tier installs.
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: this.authHeader,
      "X-Axonflow-Client": this.clientHeader,
    };
    if (this.userEmail) {
      h["X-User-Email"] = this.userEmail;
    }
    if (this.licenseToken) {
      h["X-License-Token"] = this.licenseToken;
    }
    // #2945 (epic #2919): forward the minted per-user token when configured
    // so the platform resolves a validated {identity, role} — role-scoped
    // reads return the developer's own rows and audit attribution keys on
    // the token's canonical email, beating a forged X-User-Email label.
    // Omitted when unconfigured (no empty header — byte-identical wire
    // behavior to v2.6.7). baseHeaders() is the single choke point every
    // governed request flows through; request sites that deliberately do
    // NOT use it (bootstrap /register, /health probes, telemetry heartbeat,
    // recovery CLI) are pre-auth or non-governed and never carry identity.
    if (this.userToken) {
      h["X-User-Token"] = this.userToken;
    }
    // ADR-065 capability handshake (axonflow-enterprise#3763). Omitted
    // entirely when unconfigured: a PRESENT-but-empty value is MALFORMED to
    // the platform and refuses the request, which an absent header does not.
    if (handshake) {
      h[PEP_HANDSHAKE_HEADER] = handshake;
    }
    return h;
  }

  private async fetchWithTimeout(
    url: string,
    init?: RequestInit,
    options?: { tenantCredentialRoute?: boolean },
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        // A tenant-credential route never follows a redirect (#196). fetch
        // follows one by default: a 302 came back as the target's 200 page, no
        // usable answer, so the call ran with the notice; a 307 re-sent the
        // POST to wherever the redirect pointed (cross-origin, fetch drops
        // Authorization but forwards X-License-Token and X-User-Token), and a
        // check honoured that answer. The 3xx itself is returned and read as a
        // refusal. telemetry.ts refuses redirects for the same reason.
        ...(options?.tenantCredentialRoute === true ? { redirect: "manual" as const } : {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    // Issue #2275: the auth-failure breaker is armed here, at the one fetch
    // chokepoint, but ONLY for a tenant-credential route (#196). The four
    // callers that pass `tenantCredentialRoute` (mcpCheckInput,
    // mcpCheckOutput, auditToolCall, auditLLMCall) authenticate with the
    // tenant credential alone and need no per-user identity, so a 401 there
    // means that credential failed and every later governed call would fail
    // the same way; they are also the high-volume routes the 716 x 401 storm
    // came from. Every other route (the override writes, explain, search, the
    // decision list, the agent-tools MCP server, health) can answer 401 for a
    // reason that is not the tenant credential: an identity refusal (the
    // override writes refuse a caller with no per-user identity) or that
    // route's own posture. Arming the breaker there locked every governed
    // tool call for the session after one refused override (#196). A refusal
    // never opens the breaker; a failing tenant credential still does, on the
    // next governed call.
    //
    // Idempotent: markAuthFailed() guards its own warn emit via the
    // authWarningEmitted flag, so concurrent 401s from sibling methods
    // all land in the same single warn.
    if (response.status === 401 && options?.tenantCredentialRoute === true) {
      this.markAuthFailed();
    }
    return response;
  }

  /**
   * A check-input or check-output answer that is not a 2xx, classified by its
   * STATUS, never by whether the body parses (#196). The body is read once,
   * through readErrorBody, so a plain-text answer from an ALB, nginx or WAF
   * cannot throw a SyntaxError past the breaker, and whatever reason the
   * platform sends reaches the user (#167). Returns the deny a 403 carrying
   * the platform's decision is; throws for everything else:
   *   - a 401: AxonFlowHttpError(401), the rejected credential
   *     (fetchWithTimeout has already armed the breaker);
   *   - a V1 limit envelope (on a 429 or a 403), or any 429:
   *     AxonFlowLimitError, which denies under onError=block;
   *   - anything else: AxonFlowHttpError with its status, which governance.ts
   *     reads as a refusal (3xx, 4xx) or as no usable answer (408, 5xx).
   */
  private async readCheckRefusal(
    response: Response,
    context: "check-input" | "check-output",
  ): Promise<MCPCheckInputResponse & MCPCheckOutputResponse> {
    const body = await readErrorBody(response, this.requestTimeoutMs);
    if (response.status === 401) {
      throw new AxonFlowHttpError(401, response.statusText, body, context);
    }
    const envelope = this.handleEnvelope(response.status, body, response);
    if (envelope || response.status === 429) {
      throw new AxonFlowLimitError(
        response.status,
        response.statusText,
        body,
        context,
        envelope?.limit_type,
      );
    }
    if (response.status === 403 && isDecisionBody(body)) {
      return {
        allowed: false,
        block_reason:
          typeof body["block_reason"] === "string"
            ? body["block_reason"]
            : typeof body["error"] === "string"
              ? body["error"]
              : "Blocked by policy",
        policies_evaluated: extractPoliciesEvaluated(body),
        ...extractRicherContext(body),
      };
    }
    throw new AxonFlowHttpError(response.status, response.statusText, body, context);
  }

  /**
   * The JSON object a 2xx check-input or check-output answer carries. A body
   * that is not JSON, or not an object (an array, a scalar, null), is no
   * usable answer: AxonFlowHttpError with the 2xx status, read through
   * failMode (#196).
   */
  private async readCheckBody(
    response: Response,
    context: "check-input" | "check-output",
  ): Promise<Record<string, unknown>> {
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AxonFlowHttpError(
        response.status,
        response.statusText,
        { error: "the answer was not JSON" },
        context,
      );
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new AxonFlowHttpError(
        response.status,
        response.statusText,
        { error: "the answer was not a JSON object" },
        context,
      );
    }
    return data as Record<string, unknown>;
  }

  async mcpCheckInput(
    connectorType: string,
    statement: string,
    operation: string = "execute",
  ): Promise<MCPCheckInputResponse> {
    // Issue #2275 — auth-failure circuit breaker. Once any auth-bearing
    // call has observed a 401, short-circuit subsequent governance
    // checks WITHOUT round-tripping. Throws the same AxonFlowHttpError
    // shape that a real 401 would produce so governance.ts's
    // isAxonFlowAuthError classifier + config.onError path applies
    // uniformly regardless of whether the 401 came from the wire or
    // from this local cache.
    if (this.authFailed) {
      throw new AxonFlowHttpError(
        401,
        "Unauthorized",
        { error: "Authentication previously failed; circuit breaker open" },
        "check-input",
      );
    }
    // V1 Plugin Pro back-off: an earlier check-input or check-output request
    // reached a request-rate limit and stamped its deadline, so no request is
    // sent until it passes, for at most THROTTLE_MAX_HONOUR_MS
    // (isGovernedBackOffActive). That is the limit row of the posture table
    // (#196): the check is refused as a limit, which denies under
    // onError=block and runs with the one-shot notice under onError=allow. It
    // used to answer "allowed". A limit reached through an agent tool, a
    // feature limit and another plugin's 401 cooldown never gate it.
    if (isGovernedBackOffActive()) {
      throw new AxonFlowLimitError(
        429,
        "Too Many Requests",
        { error: "a request limit was reached and its back-off is still in effect" },
        "check-input",
      );
    }
    const url = `${this.endpoint}/api/v1/mcp/check-input`;
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.baseHeaders(this.pepHandshakes?.request),
      body: JSON.stringify({
        connector_type: connectorType,
        statement,
        operation,
      }),
    }, { tenantCredentialRoute: true });

    // A 401, a limit, a refusal, or a 403 carrying the platform's decision.
    if (!response.ok) {
      return this.readCheckRefusal(response, "check-input");
    }

    const data = await this.readCheckBody(response, "check-input");
    if (typeof data["allowed"] !== "boolean") {
      return noDecision(data);
    }
    return {
      allowed: data["allowed"] === true,
      block_reason:
        typeof data["block_reason"] === "string"
          ? data["block_reason"]
          : undefined,
      policies_evaluated: extractPoliciesEvaluated(data),
      // #192: the request-phase masked statement and the flag saying the
      // redactor ran. Both are carried so governance.ts can substitute the
      // masked text and fail closed when the platform did not evaluate.
      redacted_statement:
        typeof data["redacted_statement"] === "string"
          ? (data["redacted_statement"] as string)
          : undefined,
      redaction_evaluated: data["redaction_evaluated"] === true,
      ...extractRicherContext(data),
    };
  }

  async mcpCheckOutput(
    connectorType: string,
    message: string,
  ): Promise<MCPCheckOutputResponse> {
    // Issue #2275 — auth-failure circuit breaker (mirrors mcpCheckInput).
    if (this.authFailed) {
      throw new AxonFlowHttpError(
        401,
        "Unauthorized",
        { error: "Authentication previously failed; circuit breaker open" },
        "check-output",
      );
    }
    // V1 Plugin Pro back-off — the limit row, as in mcpCheckInput.
    if (isGovernedBackOffActive()) {
      throw new AxonFlowLimitError(
        429,
        "Too Many Requests",
        { error: "a request limit was reached and its back-off is still in effect" },
        "check-output",
      );
    }
    const url = `${this.endpoint}/api/v1/mcp/check-output`;
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.baseHeaders(this.pepHandshakes?.response),
      body: JSON.stringify({
        connector_type: connectorType,
        message,
      }),
    }, { tenantCredentialRoute: true });

    // The same reading as mcpCheckInput: a 401, a limit, a refusal, or a 403
    // carrying the platform's decision.
    if (!response.ok) {
      return this.readCheckRefusal(response, "check-output");
    }

    const data = await this.readCheckBody(response, "check-output");
    if (typeof data["allowed"] !== "boolean") {
      return noDecision(data);
    }
    return {
      allowed: data["allowed"] === true,
      block_reason:
        typeof data["block_reason"] === "string"
          ? data["block_reason"]
          : undefined,
      redacted_data: data["redacted_data"] ?? undefined,
      policies_evaluated: extractPoliciesEvaluated(data),
      ...extractRicherContext(data),
    };
  }

  /**
   * Log a tool execution to the audit trail.
   * Uses POST /api/v1/audit/tool-call (tenant derived from Basic auth).
   */
  async auditToolCall(
    toolName: string,
    params: Record<string, unknown>,
    result?: unknown,
    error?: string,
    durationMs?: number,
  ): Promise<void> {
    // Issue #2275 — auth-failure circuit breaker. Fire-and-forget audit
    // is the documented call site that produced the 716 × 401 / 24h
    // storm — every after_tool_call hook fires a POST, and the catch
    // block below silently swallowed every 401. Short-circuit here so a
    // misconfigured-credentials install stops generating network traffic
    // after the first failure for the rest of the process lifetime.
    if (this.authFailed) {
      return;
    }
    const url = `${this.endpoint}/api/v1/audit/tool-call`;
    try {
      // Issue #2275: a tenant-credential route, so a 401 here arms the breaker
      // in fetchWithTimeout; no per-call status check is needed. The response
      // value is intentionally discarded (fire-and-forget audit semantics).
      await this.fetchWithTimeout(url, {
        method: "POST",
        headers: this.baseHeaders(),
        body: JSON.stringify({
          tool_name: toolName,
          // #2912 dual-send: caller_name is the correctly-named field the
          // platform resolves first (axonflow-enterprise#2953). tool_type is
          // the deprecated legacy fallback kept for the deprecation window so a
          // pre-#2953 orchestrator — which drops the unknown caller_name and
          // has no default on the REST path — still attributes the row instead
          // of writing no client field at all. Drop tool_type once the platform
          // floor includes #2953. (Distinct from auditLLMCall's tool_type:
          // "llm_call", which is a real call-type marker, not a caller id.)
          caller_name: "openclaw",
          tool_type: "openclaw",
          input: truncateStringValues(params, 500),
          output: result != null ? { result: JSON.stringify(result).slice(0, 500) } : undefined,
          success: error == null,
          error_message: error,
          duration_ms: durationMs,
        }),
      }, { tenantCredentialRoute: true });
    } catch {
      // Audit failures are non-fatal
    }
  }

  /**
   * Log an LLM call to the audit trail.
   *
   * Uses the same audit/tool-call endpoint with tool_type "llm_call".
   * The dedicated audit/llm-call endpoint requires context_id (from pre_check)
   * which the plugin doesn't have. This approach logs LLM calls as tool-call
   * audit entries, providing audit evidence without requiring prior context.
   */
  async auditLLMCall(
    provider: string,
    model: string,
    query: string,
    responseSummary: string,
    tokenUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
    latencyMs: number,
  ): Promise<void> {
    // Issue #2275 — auth-failure circuit breaker (mirrors auditToolCall).
    if (this.authFailed) {
      return;
    }
    const url = `${this.endpoint}/api/v1/audit/tool-call`;
    try {
      // Issue #2275: a tenant-credential route; see auditToolCall.
      await this.fetchWithTimeout(url, {
        method: "POST",
        headers: this.baseHeaders(),
        body: JSON.stringify({
          tool_name: `${provider}.${model}`,
          tool_type: "llm_call",
          input: { query: query.slice(0, 500) },
          output: { response_summary: responseSummary.slice(0, 200), token_usage: tokenUsage },
          success: true,
          duration_ms: latencyMs,
        }),
      }, { tenantCredentialRoute: true });
    } catch {
      // Audit failures are non-fatal
    }
  }

  /**
   * Search individual audit event records.
   *
   * Returns tool call details, policy evaluations, and timestamps
   * for compliance evidence and debugging.
   */
  async searchAuditEvents(options?: {
    startTime?: string;
    endTime?: string;
    requestType?: string;
    limit?: number;
  }): Promise<{ entries: unknown[]; total: number; error?: string }> {
    const url = `${this.endpoint}/api/v1/audit/search`;
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const body = {
      start_time: options?.startTime ?? oneHourAgo.toISOString(),
      end_time: options?.endTime ?? now.toISOString(),
      limit: Math.min(options?.limit ?? 20, 100),
      ...(options?.requestType && { request_type: options.requestType }),
    };

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: this.baseHeaders(),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        return { entries: [], total: 0, error: `HTTP ${response.status}` };
      }
      return (await response.json()) as { entries: unknown[]; total: number };
    } catch (e) {
      return { entries: [], total: 0, error: e instanceof Error ? e.message : "Unknown error" };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(`${this.endpoint}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Fetch the platform's plugin_compatibility map from /health.
   *
   * Mirrors the SDK pattern (Python `health_check_detailed()` etc.) — the
   * plugin queries `/health` at startup and reads the per-plugin
   * `min_plugin_version` and `recommended_plugin_version` entries so it
   * can log an actionable upgrade warning when its own runtime version
   * is below the floor the platform expects.
   *
   * Returns null when:
   *   - the request fails (network error, timeout, non-2xx)
   *   - the platform is older than v7.5.0 and doesn't advertise
   *     `plugin_compatibility` (graceful degradation — same posture as
   *     SDK clients reading older platforms)
   *   - the response body is malformed
   *
   * Callers treat null as "no signal" rather than an error.
   */
  async getPluginCompatibility(): Promise<{
    minPluginVersion: Record<string, string>;
    recommendedPluginVersion: Record<string, string>;
  } | null> {
    try {
      const response = await this.fetchWithTimeout(`${this.endpoint}/health`);
      if (!response.ok) return null;
      const body = (await response.json()) as Record<string, unknown>;
      const compat = body["plugin_compatibility"] as Record<string, unknown> | undefined;
      if (!compat || typeof compat !== "object") return null;
      const min = compat["min_plugin_version"];
      const rec = compat["recommended_plugin_version"];
      if (!isStringMap(min) || !isStringMap(rec)) return null;
      return {
        minPluginVersion: min,
        recommendedPluginVersion: rec,
      };
    } catch {
      return null;
    }
  }

  // ============================================================================
  // Plugin Batch 1: ADR-042 session overrides + ADR-043 explain
  // ============================================================================

  /**
   * Fetch the full explanation for a previously-made policy decision.
   *
   * Returns matched policies, risk level, override availability, rolling-24h
   * session hit count, and policy source link. Shape is frozen per ADR-043.
   *
   * Used by the CLI `explain` command and by the plugin's own block-reason
   * enrichment path. Errors are returned as null rather than thrown — the
   * caller formats a user-friendly message.
   */
  async explainDecision(decisionId: string): Promise<DecisionExplanation | null> {
    if (!decisionId) return null;
    const encoded = encodeURIComponent(decisionId);
    const url = `${this.endpoint}/api/v1/decisions/${encoded}/explain`;

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "GET",
        headers: this.baseHeaders(),
      });
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as DecisionExplanation;
    } catch {
      return null;
    }
  }

  /** List active overrides for the caller's tenant. */
  async listOverrides(options?: { policyId?: string; includeRevoked?: boolean }): Promise<{
    overrides: Array<Record<string, unknown>>;
    count: number;
  }> {
    const params = new URLSearchParams();
    if (options?.policyId) params.set("policy_id", options.policyId);
    if (options?.includeRevoked) params.set("include_revoked", "true");
    const qs = params.toString();
    const url = `${this.endpoint}/api/v1/overrides${qs ? "?" + qs : ""}`;

    const response = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: this.baseHeaders(),
    });
    if (!response.ok) {
      return { overrides: [], count: 0 };
    }
    return (await response.json()) as {
      overrides: Array<Record<string, unknown>>;
      count: number;
    };
  }

  // ============================================================================
  // Strict variants — used by agent-callable tools so transport failures are
  // surfaced as errors instead of being collapsed into empty success results.
  //
  // Existing methods above keep their swallow-on-error behavior because they
  // serve CLI / governance-hook UX paths where a network blip should not
  // crash the agent's main flow. The strict variants below throw
  // AxonFlowHttpError on non-2xx and re-throw the underlying Error on
  // network failures, so callers can decide policy.
  //
  // Adding new methods (not changing existing signatures) keeps the W4
  // tier-aware retention work in the other session unblocked.
  // ============================================================================

  /**
   * Search audit events; throws on transport / non-2xx failures instead of
   * returning a misleading `{entries: [], total: 0, error: "..."}` shape.
   * Empty result sets remain a successful return with `entries: []`.
   */
  async searchAuditEventsStrict(options?: {
    startTime?: string;
    endTime?: string;
    requestType?: string;
    limit?: number;
  }): Promise<{ entries: unknown[]; total: number }> {
    const url = `${this.endpoint}/api/v1/audit/search`;
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const body = {
      start_time: options?.startTime ?? oneHourAgo.toISOString(),
      end_time: options?.endTime ?? now.toISOString(),
      limit: Math.min(options?.limit ?? 20, 100),
      ...(options?.requestType && { request_type: options.requestType }),
    };

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new AxonFlowHttpError(
        response.status,
        response.statusText,
        await readErrorBody(response, this.requestTimeoutMs),
        "audit search",
      );
    }
    const data = (await response.json()) as {
      entries: unknown[] | null;
      total: number;
    };
    // Defensive: even after axonflow-enterprise#1834 lands and the server
    // returns `entries: []`, older deployments still in the field will
    // serve `entries: null`. Coerce so agent callers never see null.
    return {
      entries: Array.isArray(data.entries) ? data.entries : [],
      total: typeof data.total === "number" ? data.total : 0,
    };
  }

  /**
   * List active overrides; throws on transport / non-2xx failures instead
   * of returning an empty list that an agent could mistake for "no
   * overrides". Empty result sets remain a successful return.
   */
  async listOverridesStrict(options?: {
    policyId?: string;
    includeRevoked?: boolean;
  }): Promise<{
    overrides: Array<Record<string, unknown>>;
    count: number;
  }> {
    const params = new URLSearchParams();
    if (options?.policyId) params.set("policy_id", options.policyId);
    if (options?.includeRevoked) params.set("include_revoked", "true");
    const qs = params.toString();
    const url = `${this.endpoint}/api/v1/overrides${qs ? "?" + qs : ""}`;

    const response = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: this.baseHeaders(),
    });
    if (!response.ok) {
      throw new AxonFlowHttpError(
        response.status,
        response.statusText,
        await readErrorBody(response, this.requestTimeoutMs),
        "list overrides",
      );
    }
    return (await response.json()) as {
      overrides: Array<Record<string, unknown>>;
      count: number;
    };
  }

  /**
   * Fetch the full explanation for a decision; surfaces three distinct
   * outcomes that the lossy `explainDecision` cannot:
   *   - { kind: "ok", explanation }   when 2xx
   *   - { kind: "not_found" }         when 404 (decision really doesn't exist)
   *   - throws AxonFlowHttpError      on any other non-2xx
   *   - throws underlying Error       on network/timeout failures
   *
   * Without this, an agent calling a CLI-flavored `explainDecision` cannot
   * tell "no such decision" apart from "platform unreachable" — both come
   * back as `null`.
   */
  async explainDecisionStrict(
    decisionId: string,
  ): Promise<
    | { kind: "ok"; explanation: DecisionExplanation }
    | { kind: "not_found" }
  > {
    if (!decisionId) {
      throw new Error("decisionId is required");
    }
    const encoded = encodeURIComponent(decisionId);
    const url = `${this.endpoint}/api/v1/decisions/${encoded}/explain`;

    const response = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: this.baseHeaders(),
    });
    if (response.status === 404) {
      return { kind: "not_found" };
    }
    if (!response.ok) {
      throw new AxonFlowHttpError(
        response.status,
        response.statusText,
        await readErrorBody(response, this.requestTimeoutMs),
        "explain decision",
      );
    }
    const explanation = (await response.json()) as DecisionExplanation;
    return { kind: "ok", explanation };
  }

  /**
   * V1.1 decision-list (issue #1982). Surfaces the caller's recent decisions
   * — companion to `explainDecision` for "what just got blocked" UX, appeal
   * flows, and forensic decision-history tracing.
   *
   * Three-way result so callers can render the right UX without inspecting
   * status codes:
   *   - { kind: "ok", decisions }            — 200, decisions array (possibly empty)
   *   - { kind: "envelope", envelope, ... }  — 429 with V1 upgrade envelope (Free cap-hit)
   *   - throws AxonFlowHttpError             — any other non-2xx (auth, 5xx)
   *   - throws underlying Error              — network/timeout
   *
   * The 429-envelope path is the critical Pro-conversion surface per
   * feedback_429_no_upgrade_hint_is_conversion_gap.md — when the Free user
   * exceeds their tier's page cap, the upgrade wording + buy URL must be
   * surfaced to the host. The agent-tool back-off (TOOL_THROTTLE_FILE) is
   * stamped too; a decision-list limit never gates a governed tool call
   * (#196).
   */
  async listRecentDecisionsStrict(
    options?: {
      since?: string;
      decision?: "allow" | "deny" | "require_approval";
      policyId?: string;
      toolSignature?: string;
      limit?: number;
    },
  ): Promise<
    | { kind: "ok"; decisions: Array<Record<string, unknown>> }
    | { kind: "envelope"; envelope: V1RateLimitEnvelope }
  > {
    const params = new URLSearchParams();
    if (options?.since) params.set("since", options.since);
    if (options?.decision) params.set("decision", options.decision);
    if (options?.policyId) params.set("policy_id", options.policyId);
    if (options?.toolSignature) params.set("tool_signature", options.toolSignature);
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString();
    const url = `${this.endpoint}/api/v1/decisions${qs ? "?" + qs : ""}`;

    const response = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: this.baseHeaders(),
    });

    if (response.status === 429) {
      // Detect the V1 envelope via the class helper, which stamps the
      // throttle file + surfaces the upgrade wording (gated by once-per-day).
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const envelope = this.handleEnvelope(response.status, body, response, TOOL_THROTTLE_FILE);
      if (envelope) {
        return { kind: "envelope", envelope };
      }
      // Bare 429 without recognized envelope — treat as transport error so
      // the caller doesn't silently see "no decisions."
      throw new AxonFlowHttpError(
        429,
        "Too Many Requests",
        { error: typeof body === "string" ? body : JSON.stringify(body) },
        "list recent decisions",
      );
    }

    if (!response.ok) {
      throw new AxonFlowHttpError(
        response.status,
        response.statusText,
        await readErrorBody(response, this.requestTimeoutMs),
        "list recent decisions",
      );
    }
    const data = (await response.json()) as { decisions?: Array<Record<string, unknown>> };
    return {
      kind: "ok",
      decisions: Array.isArray(data.decisions) ? data.decisions : [],
    };
  }

  /**
   * Generic MCP tool-call proxy — POST `tools/call` to the agent's MCP
   * server and return the parsed result. Used by the four V1 Plugin Pro
   * proxy tools (axonflow_request_approval, axonflow_create_tenant_policy,
   * axonflow_get_cost_estimate, axonflow_list_pro_features) so an
   * OpenClaw runtime gets the same toolset claude / cursor / codex
   * auto-discover from the same MCP server.
   *
   * Two-step flow per the MCP HTTP transport contract:
   *   1. POST `initialize` to get `mcp-session-id` from response headers.
   *   2. POST `tools/call` with that session-id header.
   *
   * V1 Plugin Pro envelope detection runs on the call response — if the
   * call hit a Free-tier gate (graduated cap or Pro-only feature), the
   * envelope is detected, the upgrade prompt is surfaced via the host
   * logger, and the agent-tool back-off (TOOL_THROTTLE_FILE) is stamped; it
   * never gates a governed tool call (#196). The proxy returns an
   * `{ envelope }` shape so the agent-tool wrapper can render the locked
   * V1 wording back to the user instead of a generic error.
   *
   * NOT a hot-path helper: governed traffic uses `mcpCheckInput` /
   * `mcpCheckOutput`, which target `/api/v1/mcp/check-*` (no MCP session,
   * no JSON-RPC framing). One MCP session is reused for up to
   * MCP_SESSION_MAX_AGE_MS and dropped on any answer that is not a clean
   * result (#196).
   */
  async callMCPTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<
    | { kind: "ok"; result: unknown }
    | { kind: "envelope"; envelope: V1RateLimitEnvelope }
    | { kind: "throttled" }
    | { kind: "error"; message: string; status?: number }
  > {
    // This surface's own back-off, or a governed request-rate back-off.
    if (isThrottleActive(undefined, undefined, { file: TOOL_THROTTLE_FILE }) || isGovernedBackOffActive()) {
      return { kind: "throttled" };
    }

    const url = `${this.endpoint}/api/v1/mcp-server`;
    // Step 1: reuse the cached MCP session while it is younger than
    // MCP_SESSION_MAX_AGE_MS, else initialize a new one (#196).
    const nowMs = Date.now();
    let sessionId =
      this.mcpSession !== null &&
      nowMs - this.mcpSession.createdAtMs < AxonFlowClient.MCP_SESSION_MAX_AGE_MS
        ? this.mcpSession.id
        : null;
    if (sessionId === null) {
      this.mcpSession = null;
      const initResp = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: this.baseHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "init",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "openclaw-axonflow", version: VERSION },
          },
        }),
      });
      const freshId = initResp.headers.get("mcp-session-id");
      if (!freshId) {
        // initialize didn't return a session — probably an envelope-bearing
        // 4xx (auth path is gated) or a protocol-level error. Detect
        // envelope first so the operator still sees the upgrade prompt.
        let initBody: unknown = null;
        try {
          initBody = await initResp.json();
        } catch {
          /* non-JSON; leave body null */
        }
        const env = this.handleEnvelope(initResp.status, initBody, initResp, TOOL_THROTTLE_FILE);
        if (env) {
          return { kind: "envelope", envelope: env };
        }
        return {
          kind: "error",
          message: `MCP initialize returned no session-id (HTTP ${initResp.status})`,
          status: initResp.status,
        };
      }
      sessionId = freshId;
      this.mcpSession = { id: freshId, createdAtMs: nowMs };
    }

    // Step 2: call the tool. Any answer that is not a clean result drops the
    // cached session, so the next call initializes a new one.
    let callResp: Response;
    try {
      callResp = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: { ...this.baseHeaders(), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `call-${name}`,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
    } catch (err) {
      this.mcpSession = null;
      throw err;
    }
    if (!callResp.ok) {
      this.mcpSession = null;
    }
    let data: unknown;
    try {
      data = await callResp.json();
    } catch {
      this.mcpSession = null;
      return {
        kind: "error",
        message: `MCP tools/call returned non-JSON (HTTP ${callResp.status})`,
        status: callResp.status,
      };
    }

    // V1 envelope detection runs first — wrapped in a JSON-RPC result
    // when the agent's mcp_v1_pro_tools.go gate fires.
    const env = this.handleEnvelope(callResp.status, data, callResp, TOOL_THROTTLE_FILE);
    if (env) {
      this.mcpSession = null;
      return { kind: "envelope", envelope: env };
    }

    const obj = data as Record<string, unknown>;
    if (obj["error"]) {
      this.mcpSession = null;
      const err = obj["error"] as Record<string, unknown>;
      const msg = typeof err["message"] === "string" ? err["message"] : "JSON-RPC error";
      return { kind: "error", message: msg, status: callResp.status };
    }

    const result = obj["result"] as Record<string, unknown> | undefined;
    const content = result?.["content"] as Array<{ type?: string; text?: string }> | undefined;
    const text = content?.[0]?.text;
    if (typeof text !== "string" || text.length === 0) {
      this.mcpSession = null;
      return {
        kind: "error",
        message: "MCP tools/call result missing content[0].text",
        status: callResp.status,
      };
    }

    // The agent's V1 Pro tools return their result payload as a JSON
    // string inside content[0].text. Try to parse it; if that fails,
    // hand the plain text back so the caller can surface it raw.
    try {
      return { kind: "ok", result: JSON.parse(text) };
    } catch {
      return { kind: "ok", result: text };
    }
  }
}
