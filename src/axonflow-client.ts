/**
 * Lightweight AxonFlow API client for the plugin.
 *
 * Uses direct HTTP calls to avoid requiring the full @axonflow/sdk
 * as a runtime dependency.
 */

import type { AxonFlowPluginConfig } from "./config.js";

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
}

export interface MCPCheckOutputResponse {
  allowed: boolean;
  block_reason?: string;
  redacted_data?: unknown;
  policies_evaluated: number;
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
  }

  private baseHeaders(): Record<string, string> {
    // Tenant is derived from Basic auth credentials on the server side (RFC 6749).
    // X-Tenant-ID header is no longer sent — server knows tenant from auth.
    return {
      "Content-Type": "application/json",
      Authorization: this.authHeader,
    };
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
}
