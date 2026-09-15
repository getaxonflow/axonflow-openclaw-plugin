/**
 * message_sending hook — outbound message governance.
 *
 * Scans messages before they reach the user's channel (Telegram,
 * Discord, Slack, WhatsApp). Can cancel messages containing PII/secrets
 * or redact sensitive content.
 */

import type { ClientRef } from "./client-ref.js";
import type { AxonFlowPluginConfig } from "./config.js";
import {
  recordMessageScanned,
  recordMessageCancelled,
  recordMessageRedacted,
  recordGovernanceError,
} from "./metrics.js";
import { noteUngovernedFailOpen } from "./fail-open-notice.js";

/**
 * Create the message_sending hook handler.
 *
 * Evaluates outbound message content against AxonFlow output policies.
 * Can cancel (prevent sending) or redact (modify content) before delivery.
 * Respects config.onError for every failure of the check: "block" (the
 * default) cancels the message; "allow" delivers it ungoverned, and says so
 * once per process (#196: it used to deliver it silently).
 */
export function createMessageSendingHandler(
  clientRef: ClientRef,
  config: AxonFlowPluginConfig,
) {
  return async (event: {
    to: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ content?: string; cancel?: boolean } | undefined> => {
    if (!event.content) {
      return undefined;
    }

    recordMessageScanned();

    let check;
    try {
      check = await clientRef.current.mcpCheckOutput(
        "openclaw.message_sending",
        event.content,
      );
    } catch (err) {
      recordGovernanceError();
      if (config.onError === "allow") {
        const endpoint =
          (typeof clientRef.current.getEndpoint === "function"
            ? clientRef.current.getEndpoint()
            : "") || config.endpoint;
        noteUngovernedFailOpen(endpoint, err, "outbound message");
        return undefined; // Fail-open: allow message through ungoverned
      }
      recordMessageCancelled();
      return { cancel: true };
    }

    if (!check.allowed) {
      recordMessageCancelled();
      return {
        cancel: true,
      };
    }

    if (check.redacted_data != null) {
      recordMessageRedacted();
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
