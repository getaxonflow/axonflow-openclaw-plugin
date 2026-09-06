import { createBeforeToolCallHandler } from "../src/governance";
import type { AxonFlowPluginConfig } from "../src/config";

/**
 * #192 - the request path consumes the platform's engine-masked statement.
 *
 * ADR-056 forbids this plugin from redacting for itself, so substituting the
 * platform's masked text for the caller's parameters is the ONLY sanctioned way
 * to discharge a field_redact obligation. Before this change `mcpCheckInput`
 * did not read the field at all.
 *
 * These tests drive the REAL before_tool_call handler against a stub client
 * that returns what the platform returns, and assert on the parameters the
 * handler hands back - which is what OpenClaw actually runs the tool with. A
 * test that asserted only "the field was parsed" would pass against a build
 * that parsed it and then ignored it.
 */

const CONFIG = { endpoint: "http://localhost:8080" } as unknown as AxonFlowPluginConfig;

function handlerFor(response: Record<string, unknown>) {
  const clientRef = {
    current: {
      mcpCheckInput: jest.fn().mockResolvedValue(response),
    },
     
  } as any;
  return createBeforeToolCallHandler(clientRef, CONFIG);
}

const ORIGINAL = { query: "email sarah.chen@example.com", limit: 10 };
const MASKED = { query: "email [REDACTED]", limit: 10 };

describe("the request path discharges a redaction by substituting the masked statement", () => {
  it("runs the tool with the MASKED parameters, not the caller's original", async () => {
    const handler = handlerFor({
      allowed: true,
      policies_evaluated: 1,
      redaction_evaluated: true,
      redacted_statement: JSON.stringify(MASKED),
    });

    const result = await handler({ toolName: "web_fetch", params: ORIGINAL });

    // The assertion that matters: what the tool receives.
    expect(result?.params).toEqual(MASKED);
    expect(result?.params).not.toEqual(ORIGINAL);
    expect(result?.block).toBeFalsy();
  });

  it("leaves parameters untouched when the platform masked nothing", async () => {
    // No redacted_statement means no redaction applied, which must stay the
    // ordinary allow path - returning undefined so OpenClaw uses event.params.
    const handler = handlerFor({ allowed: true, policies_evaluated: 1, redaction_evaluated: true });

    const result = await handler({ toolName: "web_fetch", params: ORIGINAL });

    expect(result).toBeUndefined();
  });

  it("BLOCKS when the platform did not report the redactor as having run", async () => {
    // Platform contract #2563 B1: absent-or-false redaction_evaluated means the
    // redactor never ran, so "it found nothing" is indistinguishable from "it
    // never looked". Collapsing the two is how content proceeds unmasked under
    // the belief that it was checked. Checked SEPARATELY from the presence of
    // the masked text for exactly that reason.
    const handler = handlerFor({
      allowed: true,
      policies_evaluated: 1,
      redaction_evaluated: false,
      redacted_statement: JSON.stringify(MASKED),
    });

    const result = await handler({ toolName: "web_fetch", params: ORIGINAL });

    expect(result?.block).toBe(true);
    expect(result?.params).toBeUndefined();
  });

  it("BLOCKS when the masked statement cannot be parsed back into parameters", async () => {
    const handler = handlerFor({
      allowed: true,
      policies_evaluated: 1,
      redaction_evaluated: true,
      redacted_statement: "{not json",
    });

    const result = await handler({ toolName: "web_fetch", params: ORIGINAL });

    // Never a fall-through to the original: once the platform has said a
    // redaction applies, running on unmasked parameters is the outcome the
    // redaction existed to prevent.
    expect(result?.block).toBe(true);
    expect(result?.params).toBeUndefined();
  });

  it("BLOCKS when the masked statement parses to something that is not a parameter object", async () => {
    for (const notAnObject of ['"a string"', "[1,2,3]", "null", "42"]) {
      const handler = handlerFor({
        allowed: true,
        policies_evaluated: 1,
        redaction_evaluated: true,
        redacted_statement: notAnObject,
      });

      const result = await handler({ toolName: "web_fetch", params: ORIGINAL });

      expect(result?.block).toBe(true);
      expect(result?.params).toBeUndefined();
    }
  });

  it("never returns the ORIGINAL parameters on any redaction path", async () => {
    // The property behind all of the above, asserted once as a property rather
    // than inferred from the cases: whenever the platform says a redaction
    // applies, the handler either substitutes or blocks. It never hands back
    // the caller's original parameters.
    for (const response of [
      { redaction_evaluated: true, redacted_statement: JSON.stringify(MASKED) },
      { redaction_evaluated: false, redacted_statement: JSON.stringify(MASKED) },
      { redaction_evaluated: true, redacted_statement: "{not json" },
      { redaction_evaluated: true, redacted_statement: "[1]" },
    ]) {
      const handler = handlerFor({ allowed: true, policies_evaluated: 1, ...response });
      const result = await handler({ toolName: "web_fetch", params: ORIGINAL });

      // `undefined` is NOT a safe answer here. OpenClaw runs the tool with
      // event.params when the handler returns undefined, so on a path where the
      // platform said a redaction applies, returning undefined IS proceeding
      // with the caller's ORIGINAL parameters. An earlier version of this
      // assertion treated undefined as safe and let a mutant that deleted the
      // substitution walk straight past it.
      const proceededUnmasked =
        result === undefined || (!result.block && result.params === undefined);
      expect(proceededUnmasked).toBe(false);
      expect(result?.params).not.toEqual(ORIGINAL);
    }
  });
});
