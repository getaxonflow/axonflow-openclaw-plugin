import { createMessageSendingHandler } from "../src/message-guard.js";
import type { AxonFlowClient } from "../src/axonflow-client.js";
import type { AxonFlowPluginConfig } from "../src/config.js";

function mockClient(overrides: {
  outputAllowed?: boolean;
  outputBlockReason?: string;
  outputRedacted?: unknown;
} = {}) {
  return {
    mcpCheckOutput: jest.fn().mockResolvedValue({
      allowed: overrides.outputAllowed ?? true,
      block_reason: overrides.outputBlockReason,
      redacted_data: overrides.outputRedacted,
      policies_evaluated: 76,
    }),
  } as unknown as AxonFlowClient;
}

const baseConfig: AxonFlowPluginConfig = {
  endpoint: "http://localhost:8080",
  clientId: "test",
  clientSecret: "secret",
  mode: "self-hosted",
};

describe("createMessageSendingHandler", () => {
  it("allows clean message", async () => {
    const client = mockClient();
    const handler = createMessageSendingHandler(client, baseConfig);
    const result = await handler({ to: "user", content: "Hello!" });
    expect(result).toBeUndefined();
    expect(client.mcpCheckOutput).toHaveBeenCalledWith(
      "openclaw.message_sending",
      "Hello!",
    );
  });

  it("cancels message when policy blocks", async () => {
    const client = mockClient({ outputAllowed: false, outputBlockReason: "PII detected" });
    const handler = createMessageSendingHandler(client, baseConfig);
    const result = await handler({
      to: "user",
      content: "Your SSN is 123-45-6789",
    });
    expect(result).toEqual({ cancel: true });
  });

  it("redacts PII in message content", async () => {
    const client = mockClient({
      outputAllowed: true,
      outputRedacted: "Your SSN is ***-**-6789",
    });
    const handler = createMessageSendingHandler(client, baseConfig);
    const result = await handler({
      to: "user",
      content: "Your SSN is 123-45-6789",
    });
    expect(result).toEqual({ content: "Your SSN is ***-**-6789" });
  });

  it("skips empty content", async () => {
    const client = mockClient();
    const handler = createMessageSendingHandler(client, baseConfig);
    const result = await handler({ to: "user", content: "" });
    expect(result).toBeUndefined();
    expect(client.mcpCheckOutput).not.toHaveBeenCalled();
  });

  it("handles object redacted_data by JSON-stringifying", async () => {
    const client = mockClient({
      outputAllowed: true,
      outputRedacted: { text: "Redacted content" },
    });
    const handler = createMessageSendingHandler(client, baseConfig);
    const result = await handler({ to: "user", content: "original" });
    expect(result?.content).toBe('{"text":"Redacted content"}');
  });

  it("cancels message on network error when onError=block (default)", async () => {
    const client = mockClient();
    (client.mcpCheckOutput as jest.Mock).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const handler = createMessageSendingHandler(client, baseConfig);
    const result = await handler({ to: "user", content: "Hello" });
    expect(result).toEqual({ cancel: true });
  });

  it("allows message on network error when onError=allow", async () => {
    const client = mockClient();
    (client.mcpCheckOutput as jest.Mock).mockRejectedValueOnce(new Error("timeout"));
    const config = { ...baseConfig, onError: "allow" as const };
    const handler = createMessageSendingHandler(client, config);
    const result = await handler({ to: "user", content: "Hello" });
    expect(result).toBeUndefined();
  });
});
