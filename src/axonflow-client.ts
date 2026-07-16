/**
 * Lightweight AxonFlow API client for the plugin.
 *
 * Uses direct HTTP calls to avoid requiring the full @axonflow/sdk
 * as a runtime dependency.
 */

import type { AxonFlowPluginConfig } from "./config.js";
import {
  handleEnvelope as handleV1Envelope,
  isThrottleActive,
  type UpgradePromptLogger,
  type V1RateLimitEnvelope,
} from "./upgrade-prompt.js";
import { VERSION } from "./version.js";

/**
 * Typed error thrown by the AxonFlow client on non-2xx HTTP responses
 * (except 403, which is a policy block and handled separately).
 *
 * Exposes `.status` as a dedicated field so downstream consumers —
 * specifically the `isAxonFlowAuthError` classifier in `governance.ts` —
 * can reliably check the HTTP status instead of pattern-matching the
 * error message string. Previously the client threw a plain `Error`
 * with the status number embedded in the message, which forced the
 * classifier to use fragile substring matching.
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
    const serverError = typeof responseBody["error"] === "string"
      ? responseBody["error"]
      : "";
    super(`AxonFlow ${context} failed: HTTP ${status} ${statusText}${serverError ? " — " + serverError : ""}`);
    this.name = "AxonFlowHttpError";
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
    // Preserve prototype chain for instanceof checks across module boundaries.
    Object.setPrototypeOf(this, AxonFlowHttpError.prototype);
  }
}

export interface MCPCheckInputResponse {
  allowed: boolean;
  block_reason?: string;
  policies_evaluated: number;
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
  policies_evaluated: number;
  decision_id?: string;
  policy_matches?: ExplainPolicy[];
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

// ADR-042: Session override types.
export interface CreateOverrideOptions {
  policyId: string;
  policyType: "static" | "dynamic";
  overrideReason: string; // mandatory per ADR-042
  toolSignature?: string;
  ttlSeconds?: number; // clamped server-side (default 60m, hard cap 24h)
}

export interface CreateOverrideResult {
  id: string;
  policy_id: string;
  policy_type: string;
  expires_at: string;
  ttl_seconds: number;
  requested_ttl?: number;
  clamped?: boolean;
  clamped_reason?: string;
  created_at: string;
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
  // Fix: once any auth-bearing call observes a 401, flip the flag and
  // short-circuit every subsequent governed/audit call without round-
  // tripping. Process-local — a new AxonFlowClient instance (e.g. after
  // config reload) starts fresh.
  //
  // 2026-05-20 follow-up hardening: 401 detection is centralized in
  // fetchWithTimeout so EVERY fetch site (~19 endpoints — search, explain,
  // overrides, health, listRecentDecisions, callMCPTool, etc.) flips the
  // flag, not just the four high-volume entry points that short-circuit
  // on the NEXT call. mcpCheckInput / mcpCheckOutput also detect 401
  // BEFORE response.json() so a non-JSON 401 body (text/plain from
  // ALB / nginx / WAF / API Gateway) doesn't throw SyntaxError and
  // propagate past the typed-error contract.
  private authFailed: boolean = false;
  // Companion to authFailed — guards `console.warn` so the operator sees
  // the failure exactly once per process lifetime, even if multiple
  // methods cross the 401 boundary concurrently.
  private authWarningEmitted: boolean = false;
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
    // Store per-user identity for Plugin Batch 1 endpoints — createOverride /
    // revokeOverride / listOverrides all require it, and explain's
    // historical_hit_count scope depends on it.
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
   * Internal helper: detect + handle a V1 envelope on a non-2xx
   * response. Returns the parsed envelope (so the caller can decide
   * how to surface it through its existing return shape) or null if
   * the response is not envelope-bearing.
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
    });
    return result.envelope ?? null;
  }

  /**
   * V1 Plugin Pro back-off gate. Callers (governance.ts) check this
   * BEFORE issuing a governed call — when the throttle file is in
   * effect, the call is short-circuited and the caller falls open
   * (the upgrade prompt was already surfaced when the throttle
   * landed; the cap clears at the deadline).
   */
  isV1ThrottleActive(): boolean {
    return isThrottleActive();
  }

  /**
   * Issue #2275 — process-local auth-failure circuit breaker.
   *
   * Returns true once any auth-bearing call has observed an HTTP 401.
   * Test-only / introspection helper; production callers do NOT need to
   * branch on this — the four governed/audit entry points consult the
   * private `authFailed` flag directly and short-circuit BEFORE issuing
   * the network call. Detection is centralized in `fetchWithTimeout` so
   * EVERY caller (~19 fetch sites) participates in flag-flipping, even
   * if only the four high-volume entry points short-circuit on the next
   * call.
   */
  isAuthFailed(): boolean {
    return this.authFailed;
  }

  /**
   * Issue #2275 — flip the circuit breaker.
   *
   * Called from any entry point that observes a real HTTP 401 from the
   * platform. Idempotent: only emits the operator-visible warning the
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
      console.warn(
        "[AxonFlow] Authentication failed (HTTP 401). Audit calls disabled for this session. Refresh credentials via the OpenClaw runtime config.",
      );
    }
  }

  private baseHeaders(): Record<string, string> {
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
    return h;
  }

  private async fetchWithTimeout(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    // Issue #2275 follow-up — centralize 401 detection at the single fetch
    // chokepoint so the breaker engages regardless of which entry point
    // is responsible for the network call. Pre-fix, only four of ~19
    // fetch sites checked status === 401 — bad creds caused 401 storms
    // on every other endpoint (search, explain, overrides, health,
    // listRecentDecisions, etc.) just at lower volume than the audit
    // endpoint. With this centralized hook, every call site benefits.
    //
    // Idempotent: markAuthFailed() guards its own warn emit via the
    // authWarningEmitted flag, so concurrent 401s from sibling methods
    // all land in the same single warn even though we don't gate
    // markAuthFailed() itself behind !this.authFailed here.
    if (response.status === 401) {
      this.markAuthFailed();
    }
    return response;
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
    // V1 Plugin Pro back-off: when a recent governed call returned a
    // 429 / 403 envelope, the throttle stamp suppresses outbound traffic
    // until the deadline. Fall open immediately so the user's tool isn't
    // held up while we wait the cap out (the upgrade prompt was already
    // surfaced when the throttle landed).
    if (isThrottleActive()) {
      return { allowed: true, policies_evaluated: 0 };
    }
    const url = `${this.endpoint}/api/v1/mcp/check-input`;
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({
        connector_type: connectorType,
        statement,
        operation,
      }),
    });

    // Issue #2275 follow-up — detect 401 BEFORE response.json() so a
    // non-JSON 401 body (text/plain "Unauthorized" from ALB / nginx /
    // WAF / API Gateway infra layers) doesn't throw SyntaxError and
    // propagate past the breaker. fetchWithTimeout already flipped
    // the authFailed flag for any 401; we just need to surface the
    // typed error in the same shape the JSON-body path would have.
    if (response.status === 401) {
      throw new AxonFlowHttpError(
        401,
        response.statusText,
        {},
        "check-input",
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    // V1 Plugin Pro envelope detection runs BEFORE the policy-block
    // branch — an envelope-bearing 403 (graduated cap, Pro-only feature)
    // is structurally distinguishable from a policy-block 403 by its
    // `limit_type` field, and the user-facing semantics differ:
    // policy block = "this tool call hit a policy",
    // envelope = "this account hit a tier cap; Pro removes it".
    if (this.handleEnvelope(response.status, data, response)) {
      // Cap reached — fall open (allowed=true). The wording was already
      // surfaced via the upgrade-prompt logger and a throttle deadline
      // was stamped so the next call short-circuits at the gate.
      return {
        allowed: true,
        policies_evaluated: 0,
      };
    }

    if (response.status === 403) {
      return {
        allowed: false,
        block_reason:
          typeof data["block_reason"] === "string"
            ? data["block_reason"]
            : typeof data["error"] === "string"
              ? data["error"]
              : "Blocked by policy",
        policies_evaluated: extractPoliciesEvaluated(data),
        ...extractRicherContext(data),
      };
    }

    if (!response.ok) {
      // 401 already handled above (pre-json branch). Any other non-2xx
      // status here is transient and the existing fail-open / fail-
      // closed path in governance.ts handles them per config.onError.
      throw new AxonFlowHttpError(
        response.status,
        response.statusText,
        data,
        "check-input",
      );
    }

    return {
      allowed: data["allowed"] === true,
      block_reason:
        typeof data["block_reason"] === "string"
          ? data["block_reason"]
          : undefined,
      policies_evaluated: extractPoliciesEvaluated(data),
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
    // V1 Plugin Pro back-off — same rationale as mcpCheckInput.
    if (isThrottleActive()) {
      return { allowed: true, policies_evaluated: 0 };
    }
    const url = `${this.endpoint}/api/v1/mcp/check-output`;
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({
        connector_type: connectorType,
        message,
      }),
    });

    // Issue #2275 follow-up — detect 401 BEFORE response.json() (see
    // mcpCheckInput for full rationale). Mirror the exact AxonFlowHttpError
    // shape so the governance.ts classifier behaves identically across
    // input + output paths.
    if (response.status === 401) {
      throw new AxonFlowHttpError(
        401,
        response.statusText,
        {},
        "check-output",
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    // V1 Plugin Pro envelope detection — see mcpCheckInput for rationale.
    // Output scan falls open on cap (no PII detection during back-off
    // is acceptable — the upgrade prompt was already surfaced).
    if (this.handleEnvelope(response.status, data, response)) {
      return {
        allowed: true,
        policies_evaluated: 0,
      };
    }

    if (response.status === 403) {
      return {
        allowed: false,
        block_reason:
          typeof data["block_reason"] === "string"
            ? data["block_reason"]
            : typeof data["error"] === "string"
              ? data["error"]
              : "Blocked by policy",
        policies_evaluated: extractPoliciesEvaluated(data),
        ...extractRicherContext(data),
      };
    }

    if (!response.ok) {
      // 401 already handled above (pre-json branch). Any other non-2xx
      // status here is transient and the existing fail-open / fail-
      // closed path in governance.ts handles them per config.onError.
      throw new AxonFlowHttpError(
        response.status,
        response.statusText,
        data,
        "check-output",
      );
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
      // Issue #2275 follow-up — the centralized 401 detection in
      // fetchWithTimeout flips the authFailed flag for us; no need for
      // an explicit per-call response.status check here. Response value
      // is intentionally discarded (fire-and-forget audit semantics).
      await this.fetchWithTimeout(url, {
        method: "POST",
        headers: this.baseHeaders(),
        body: JSON.stringify({
          tool_name: toolName,
          tool_type: "openclaw",
          input: truncateStringValues(params, 500),
          output: result != null ? { result: JSON.stringify(result).slice(0, 500) } : undefined,
          success: error == null,
          error_message: error,
          duration_ms: durationMs,
        }),
      });
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
      // Issue #2275 follow-up — centralized 401 detection in
      // fetchWithTimeout handles the breaker flip. See auditToolCall.
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
      });
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

  /**
   * Create a session-scoped override for a policy the caller was blocked by.
   *
   * ADR-042 rules enforced server-side:
   *   - TTL clamped to [1min, 24h], default 60m.
   *   - Critical-risk policies rejected (403).
   *   - allow_override=false policies rejected (403).
   *   - Justification (overrideReason) is mandatory.
   *
   * Plugin does minimal client-side validation and lets the platform
   * enforce invariants.
   */
  async createOverride(opts: CreateOverrideOptions): Promise<CreateOverrideResult> {
    if (!opts.overrideReason || !opts.overrideReason.trim()) {
      throw new Error("overrideReason is required (ADR-042: mandatory justification)");
    }
    const url = `${this.endpoint}/api/v1/overrides`;
    const body: Record<string, unknown> = {
      policy_id: opts.policyId,
      policy_type: opts.policyType,
      override_reason: opts.overrideReason,
    };
    if (opts.toolSignature) body.tool_signature = opts.toolSignature;
    if (opts.ttlSeconds !== undefined) body.ttl_seconds = opts.ttlSeconds;

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new AxonFlowHttpError(
        response.status,
        response.statusText,
        { error: text },
        "create override",
      );
    }
    return (await response.json()) as CreateOverrideResult;
  }

  /** Revoke a previously-created override. */
  async revokeOverride(overrideId: string): Promise<void> {
    if (!overrideId) throw new Error("overrideId is required");
    const url = `${this.endpoint}/api/v1/overrides/${encodeURIComponent(overrideId)}`;
    const response = await this.fetchWithTimeout(url, {
      method: "DELETE",
      headers: this.baseHeaders(),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new AxonFlowHttpError(
        response.status,
        response.statusText,
        { error: text },
        "revoke override",
      );
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
      const text = await response.text();
      throw new AxonFlowHttpError(
        response.status,
        response.statusText,
        { error: text },
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
      const text = await response.text();
      throw new AxonFlowHttpError(
        response.status,
        response.statusText,
        { error: text },
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
      const text = await response.text();
      throw new AxonFlowHttpError(
        response.status,
        response.statusText,
        { error: text },
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
   * surfaced to the host. We also stamp the throttle-gate file so the
   * caller's next governed call can short-circuit instead of round-tripping.
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
      const envelope = this.handleEnvelope(response.status, body, response);
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
      const text = await response.text();
      throw new AxonFlowHttpError(
        response.status,
        response.statusText,
        { error: text },
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
   * logger, and the throttle file is stamped. The proxy returns an
   * `{ envelope }` shape so the agent-tool wrapper can render the locked
   * V1 wording back to the user instead of a generic error.
   *
   * NOT a hot-path helper. Initializes a fresh MCP session per call —
   * agent-tools are user-driven and rare; session caching would add
   * complexity (TTL handling, cross-call lock) that's not worth it for
   * this surface. Hot-path traffic uses the dedicated `mcpCheckInput`
   * / `mcpCheckOutput` paths above which target `/api/v1/mcp/check-*`
   * (no MCP session, no JSON-RPC framing).
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
    if (isThrottleActive()) {
      return { kind: "throttled" };
    }

    const url = `${this.endpoint}/api/v1/mcp-server`;
    // Step 1: initialize the MCP session.
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
    const sessionId = initResp.headers.get("mcp-session-id");
    if (!sessionId) {
      // initialize didn't return a session — probably an envelope-bearing
      // 4xx (auth path is gated) or a protocol-level error. Detect
      // envelope first so the operator still sees the upgrade prompt.
      let initBody: unknown = null;
      try {
        initBody = await initResp.json();
      } catch {
        /* non-JSON; leave body null */
      }
      const env = this.handleEnvelope(initResp.status, initBody, initResp);
      if (env) {
        return { kind: "envelope", envelope: env };
      }
      return {
        kind: "error",
        message: `MCP initialize returned no session-id (HTTP ${initResp.status})`,
        status: initResp.status,
      };
    }

    // Step 2: call the tool.
    const callResp = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { ...this.baseHeaders(), "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `call-${name}`,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    let data: unknown;
    try {
      data = await callResp.json();
    } catch {
      return {
        kind: "error",
        message: `MCP tools/call returned non-JSON (HTTP ${callResp.status})`,
        status: callResp.status,
      };
    }

    // V1 envelope detection runs first — wrapped in a JSON-RPC result
    // when the agent's mcp_v1_pro_tools.go gate fires.
    const env = this.handleEnvelope(callResp.status, data, callResp);
    if (env) {
      return { kind: "envelope", envelope: env };
    }

    const obj = data as Record<string, unknown>;
    if (obj["error"]) {
      const err = obj["error"] as Record<string, unknown>;
      const msg = typeof err["message"] === "string" ? err["message"] : "JSON-RPC error";
      return { kind: "error", message: msg, status: callResp.status };
    }

    const result = obj["result"] as Record<string, unknown> | undefined;
    const content = result?.["content"] as Array<{ type?: string; text?: string }> | undefined;
    const text = content?.[0]?.text;
    if (typeof text !== "string" || text.length === 0) {
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
