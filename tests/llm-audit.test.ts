import { createLlmInputHandler, createLlmOutputHandler } from "../src/llm-audit.js";
import type { AxonFlowClient } from "../src/axonflow-client.js";
import type { AxonFlowPluginConfig } from "../src/config.js";

function mockClient() {
  return {
    auditLLMCall: jest.fn().mockResolvedValue(undefined),
  } as unknown as AxonFlowClient;
}

const baseConfig: AxonFlowPluginConfig = {
  endpoint: "http://localhost:8080",
  clientId: "test",
  clientSecret: "secret",
  mode: "self-hosted",
};

describe("LLM audit hooks", () => {
  describe("createLlmInputHandler", () => {
    it("stores call state by runId", () => {
      const client = mockClient();
      const state = new Map();
      const handler = createLlmInputHandler({ current: client }, baseConfig, state);

      handler({
        runId: "run-1",
        sessionId: "sess-1",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        prompt: "Hello world",
        historyMessages: [],
        imagesCount: 0,
      });

      expect(state.has("run-1")).toBe(true);
      const stored = state.get("run-1");
      expect(stored.provider).toBe("anthropic");
      expect(stored.model).toBe("claude-sonnet-4-6");
      expect(stored.prompt).toBe("Hello world");
      expect(stored.startMs).toBeGreaterThan(0);
    });

    it("truncates long prompts to 500 chars", () => {
      const client = mockClient();
      const state = new Map();
      const handler = createLlmInputHandler({ current: client }, baseConfig, state);

      handler({
        runId: "run-2",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-4",
        prompt: "x".repeat(1000),
        historyMessages: [],
        imagesCount: 0,
      });

      expect(state.get("run-2")?.prompt.length).toBe(500);
    });
  });

  describe("createLlmOutputHandler", () => {
    it("sends audit with correlated input state", async () => {
      const client = mockClient();
      const state = new Map();
      state.set("run-1", {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        prompt: "Hello",
        startMs: Date.now() - 150,
      });

      const handler = createLlmOutputHandler({ current: client }, baseConfig, state);

      await handler({
        runId: "run-1",
        sessionId: "sess-1",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        assistantTexts: ["Hi there!", "How can I help?"],
        usage: { input: 10, output: 20, total: 30 },
      });

      expect(client.auditLLMCall).toHaveBeenCalledWith(
        "anthropic",
        "claude-sonnet-4-6",
        "Hello",
        "Hi there! How can I help?",
        { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        expect.any(Number),
      );

      // State should be cleaned up
      expect(state.has("run-1")).toBe(false);
    });

    it("works without input state (fallback to event fields)", async () => {
      const client = mockClient();
      const state = new Map();
      const handler = createLlmOutputHandler({ current: client }, baseConfig, state);

      await handler({
        runId: "run-orphan",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-4",
        assistantTexts: ["Response text"],
      });

      expect(client.auditLLMCall).toHaveBeenCalledWith(
        "openai",
        "gpt-4",
        "",
        "Response text",
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        0,
      );
    });

    it("does not throw on audit failure", async () => {
      const client = mockClient();
      (client.auditLLMCall as jest.Mock).mockRejectedValueOnce(new Error("Network error"));
      const state = new Map();
      const handler = createLlmOutputHandler({ current: client }, baseConfig, state);

      // Should not throw
      await handler({
        runId: "run-fail",
        sessionId: "sess-1",
        provider: "test",
        model: "test",
        assistantTexts: ["text"],
      });
    });

    it("truncates long response summaries to 200 chars", async () => {
      const client = mockClient();
      const state = new Map();
      const handler = createLlmOutputHandler({ current: client }, baseConfig, state);

      await handler({
        runId: "run-long",
        sessionId: "sess-1",
        provider: "test",
        model: "test",
        assistantTexts: ["y".repeat(500)],
      });

      const callArgs = (client.auditLLMCall as jest.Mock).mock.calls[0];
      expect(callArgs[3].length).toBeLessThanOrEqual(200);
    });
  });
});
