/**
 * tool_result_persist hook — output governance.
 *
 * Evaluates tool results against AxonFlow policies before they are
 * persisted to the session transcript. Can redact PII/secrets or
 * block the result entirely.
 */

import type { AxonFlowClient } from "./axonflow-client.js";
import type { AxonFlowPluginConfig } from "./config.js";
import { shouldGovernTool } from "./config.js";
import { deriveConnectorType } from "./governance.js";

/**
 * Extract text content from an OpenClaw AgentMessage for policy evaluation.
 *
 * AgentMessage content can be a string or structured content array.
 * We extract text for the output policy check.
 */
export function extractTextContent(message: Record<string, unknown>): string {
  const content = message["content"];

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        textParts.push(part);
      } else if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof (part as Record<string, unknown>)["text"] === "string"
      ) {
        textParts.push((part as Record<string, unknown>)["text"] as string);
      }
    }
    return textParts.join(" ");
  }

  if (content != null) {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  return "";
}

/**
 * Create the tool_result_persist hook handler.
 *
 * Evaluates tool output against AxonFlow policies. If PII/secrets
 * are detected, the result is redacted before persistence.
 */
export function createOutputGuardHandler(
  client: AxonFlowClient,
  config: AxonFlowPluginConfig,
) {
  return async (event: {
    toolName?: string;
    toolCallId?: string;
    message: Record<string, unknown>;
    isSynthetic?: boolean;
  }): Promise<{ message?: Record<string, unknown> } | undefined> => {
    // Skip synthetic (guard-generated) messages to avoid infinite loops
    if (event.isSynthetic) {
      return undefined;
    }

    const toolName = event.toolName ?? "unknown";

    if (!shouldGovernTool(toolName, config)) {
      return undefined;
    }

    const content = extractTextContent(event.message);
    if (!content) {
      return undefined;
    }

    const connectorType = deriveConnectorType(toolName);
    const check = await client.mcpCheckOutput(connectorType, content);

    if (!check.allowed) {
      // Block: replace the message content with the block reason
      return {
        message: {
          ...event.message,
          content: `[AxonFlow] Tool output blocked: ${check.block_reason ?? "policy violation"}`,
        },
      };
    }

    if (check.redacted_data != null) {
      // Redact: replace content with the redacted version
      return {
        message: {
          ...event.message,
          content:
            typeof check.redacted_data === "string"
              ? check.redacted_data
              : JSON.stringify(check.redacted_data),
        },
      };
    }

    return undefined;
  };
}
