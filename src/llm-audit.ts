/**
 * llm_input and llm_output hooks — LLM call audit logging.
 *
 * Records what the LLM sees (prompt, model, provider) and produces
 * (response, token usage) to AxonFlow's audit trail. These hooks are
 * observe-only (cannot block or modify), so they provide audit
 * evidence, not governance.
 */

import type { AxonFlowClient } from "./axonflow-client.js";
import type { AxonFlowPluginConfig } from "./config.js";

/** Shared state for correlating llm_input with llm_output. */
interface LLMCallState {
  provider: string;
  model: string;
  prompt: string;
  startMs: number;
}

/**
 * Create the llm_input hook handler.
 *
 * Records the prompt, model, and provider at the start of each LLM call.
 * Stores state by runId for correlation with the llm_output handler.
 */
export function createLlmInputHandler(
  _client: AxonFlowClient,
  _config: AxonFlowPluginConfig,
  callState: Map<string, LLMCallState>,
) {
  return (event: {
    runId: string;
    sessionId: string;
    provider: string;
    model: string;
    systemPrompt?: string;
    prompt: string;
    historyMessages: unknown[];
    imagesCount: number;
  }): void => {
    callState.set(event.runId, {
      provider: event.provider,
      model: event.model,
      prompt: event.prompt.slice(0, 500),
      startMs: Date.now(),
    });

    // Prevent unbounded growth: evict entries older than 5 minutes.
    // Handles cases where llm_input fires without a matching llm_output
    // (LLM errors, timeouts, network failures).
    const MAX_AGE_MS = 5 * 60 * 1000;
    const now = Date.now();
    for (const [key, val] of callState) {
      if (now - val.startMs > MAX_AGE_MS) {
        callState.delete(key);
      }
    }
  };
}

/**
 * Create the llm_output hook handler.
 *
 * Correlates with the stored llm_input state and sends a complete
 * audit entry to AxonFlow (provider, model, prompt summary, response
 * summary, token usage, latency).
 */
export function createLlmOutputHandler(
  client: AxonFlowClient,
  _config: AxonFlowPluginConfig,
  callState: Map<string, LLMCallState>,
) {
  return async (event: {
    runId: string;
    sessionId: string;
    provider: string;
    model: string;
    assistantTexts: string[];
    lastAssistant?: unknown;
    usage?: {
      input?: number;
      output?: number;
      total?: number;
    };
  }): Promise<void> => {
    const inputState = callState.get(event.runId);
    callState.delete(event.runId);

    const responseSummary = event.assistantTexts.join(" ").slice(0, 200);
    const latencyMs = inputState ? Date.now() - inputState.startMs : 0;

    try {
      await client.auditLLMCall(
        inputState?.provider ?? event.provider,
        inputState?.model ?? event.model,
        inputState?.prompt ?? "",
        responseSummary,
        {
          prompt_tokens: event.usage?.input ?? 0,
          completion_tokens: event.usage?.output ?? 0,
          total_tokens: event.usage?.total ?? 0,
        },
        latencyMs,
      );
    } catch {
      // Audit failures are non-fatal
    }
  };
}
