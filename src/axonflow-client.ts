/**
 * Lightweight AxonFlow API client for the plugin.
 *
 * Uses direct HTTP calls to avoid requiring the full @axonflow/sdk
 * as a runtime dependency.
 */

import type { AxonFlowPluginConfig } from "./config.js";
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

export class AxonFlowClient {
  private readonly endpoint: string;
  private readonly authHeader: string;
  private readonly requestTimeoutMs: number;
  private readonly userEmail: string | undefined;
  private readonly licenseToken: string | undefined;
  private readonly clientHeader: string;
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
    // ADR-050 §4: every governed request carries X-Axonflow-Client so the
    // agent can derive request scope (plugin/sdk/full) and validate it
    // against the token's aud.scope. Computed once at construction; never
    // sourced from config or env (the consumer doesn't get to spoof its
    // own client identity to the agent).
    this.clientHeader = `openclaw/${VERSION}`;
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
    return h;
  }

  private async fetchWithTimeout(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async mcpCheckInput(
    connectorType: string,
    statement: string,
    operation: string = "execute",
  ): Promise<MCPCheckInputResponse> {
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

    const data = (await response.json()) as Record<string, unknown>;

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
    const url = `${this.endpoint}/api/v1/mcp/check-output`;
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({
        connector_type: connectorType,
        message,
      }),
    });

    const data = (await response.json()) as Record<string, unknown>;

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
    const url = `${this.endpoint}/api/v1/audit/tool-call`;
    try {
      await this.fetchWithTimeout(url, {
        method: "POST",
        headers: this.baseHeaders(),
        body: JSON.stringify({
          tool_name: toolName,
          tool_type: "openclaw",
          input: params,
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
    const url = `${this.endpoint}/api/v1/audit/tool-call`;
    try {
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
}
