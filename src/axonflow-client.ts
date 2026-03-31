/**
 * Lightweight AxonFlow API client for the plugin.
 *
 * Uses direct HTTP calls to avoid requiring the full @axonflow/sdk
 * as a runtime dependency (it's a peer dependency for users who want
 * the full SDK, but the plugin only needs check-input/check-output/audit).
 */

import type { AxonFlowPluginConfig } from "./config.js";

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

export interface AuditToolCallResponse {
  success: boolean;
  audit_id?: string;
}

/**
 * Extract policies_evaluated count from API response.
 * The platform returns this as a top-level number on 403 responses,
 * or inside policy_info.policies_evaluated (which can be a number or
 * array of policy names) on 200 responses.
 */
function extractPoliciesEvaluated(data: Record<string, unknown>): number {
  // Top-level number (common in 403 responses)
  if (typeof data["policies_evaluated"] === "number") {
    return data["policies_evaluated"];
  }
  // Inside policy_info (common in 200 responses)
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

  constructor(config: AxonFlowPluginConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    const credentials = Buffer.from(
      `${config.clientId}:${config.clientSecret}`,
    ).toString("base64");
    this.authHeader = `Basic ${credentials}`;
  }

  async mcpCheckInput(
    connectorType: string,
    statement: string,
    operation: string = "execute",
  ): Promise<MCPCheckInputResponse> {
    const url = `${this.endpoint}/api/v1/mcp/check-input`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader,
      },
      body: JSON.stringify({
        connector_type: connectorType,
        statement,
        operation,
      }),
    });

    const data = (await response.json()) as Record<string, unknown>;

    // 403 with response body is a policy block (not an auth error)
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
      throw new Error(
        `AxonFlow check-input failed: ${response.status} ${typeof data["error"] === "string" ? data["error"] : ""}`,
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
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader,
      },
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
      throw new Error(
        `AxonFlow check-output failed: ${response.status} ${typeof data["error"] === "string" ? data["error"] : ""}`,
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

  async auditToolCall(
    toolName: string,
    params: Record<string, unknown>,
    result?: unknown,
    error?: string,
    durationMs?: number,
  ): Promise<void> {
    const url = `${this.endpoint}/api/v1/audit/tool-call`;
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.authHeader,
        },
        body: JSON.stringify({
          tool_name: toolName,
          tool_type: "openclaw",
          input: params,
          output: result != null ? { result: String(result).slice(0, 500) } : undefined,
          success: error == null,
          error_message: error,
          duration_ms: durationMs,
        }),
      });
    } catch {
      // Audit failures are non-fatal — governance already enforced
    }
  }

  async auditLLMCall(
    provider: string,
    model: string,
    query: string,
    responseSummary: string,
    tokenUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
    latencyMs: number,
  ): Promise<void> {
    const url = `${this.endpoint}/api/audit/llm-call`;
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.authHeader,
        },
        body: JSON.stringify({
          provider,
          model,
          query: query.slice(0, 500),
          response_summary: responseSummary.slice(0, 200),
          token_usage: tokenUsage,
          latency_ms: latencyMs,
        }),
      });
    } catch {
      // Audit failures are non-fatal
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
