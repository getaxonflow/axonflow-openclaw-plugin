/**
 * message_sending hook — outbound message governance.
 *
 * Scans messages before they reach the user's channel (Telegram,
 * Discord, Slack, WhatsApp). Can cancel messages containing PII/secrets
 * or redact sensitive content.
 */

import type { AxonFlowClient } from "./axonflow-client.js";
import type { AxonFlowPluginConfig } from "./config.js";

/**
 * Create the message_sending hook handler.
 *
 * Evaluates outbound message content against AxonFlow output policies.
 * Can cancel (prevent sending) or redact (modify content) before delivery.
 */
export function createMessageSendingHandler(
  client: AxonFlowClient,
  _config: AxonFlowPluginConfig,
) {
  return async (event: {
    to: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ content?: string; cancel?: boolean } | undefined> => {
    if (!event.content) {
      return undefined;
    }

    const check = await client.mcpCheckOutput(
      "openclaw.message_sending",
      event.content,
    );

    if (!check.allowed) {
      return {
        cancel: true,
      };
    }

    if (check.redacted_data != null) {
      return {
        content:
          typeof check.redacted_data === "string"
            ? check.redacted_data
            : JSON.stringify(check.redacted_data),
      };
    }

    return undefined;
  };
}
