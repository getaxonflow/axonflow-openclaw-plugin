import {
  getMetrics,
  resetMetrics,
  recordToolCallEvaluated,
  recordToolCallBlocked,
  recordToolCallApprovalRequired,
  recordToolCallAllowed,
  recordMessageScanned,
  recordMessageCancelled,
  recordMessageRedacted,
  recordAuditEventSent,
  recordGovernanceError,
} from "../src/metrics.js";

beforeEach(() => {
  resetMetrics();
});

describe("GovernanceMetrics", () => {
  it("starts with all zeros", () => {
    const m = getMetrics();
    expect(m.toolCallsEvaluated).toBe(0);
    expect(m.toolCallsBlocked).toBe(0);
    expect(m.toolCallsApprovalRequired).toBe(0);
    expect(m.toolCallsAllowed).toBe(0);
    expect(m.messagesScanned).toBe(0);
    expect(m.messagesCancelled).toBe(0);
    expect(m.messagesRedacted).toBe(0);
    expect(m.auditEventsSent).toBe(0);
    expect(m.governanceErrors).toBe(0);
    expect(m.startedAt).toBeDefined();
  });

  it("increments tool call counters", () => {
    recordToolCallEvaluated();
    recordToolCallEvaluated();
    recordToolCallBlocked();
    recordToolCallApprovalRequired();
    recordToolCallAllowed();

    const m = getMetrics();
    expect(m.toolCallsEvaluated).toBe(2);
    expect(m.toolCallsBlocked).toBe(1);
    expect(m.toolCallsApprovalRequired).toBe(1);
    expect(m.toolCallsAllowed).toBe(1);
  });

  it("increments message counters", () => {
    recordMessageScanned();
    recordMessageScanned();
    recordMessageScanned();
    recordMessageCancelled();
    recordMessageRedacted();

    const m = getMetrics();
    expect(m.messagesScanned).toBe(3);
    expect(m.messagesCancelled).toBe(1);
    expect(m.messagesRedacted).toBe(1);
  });

  it("increments audit and error counters", () => {
    recordAuditEventSent();
    recordAuditEventSent();
    recordGovernanceError();

    const m = getMetrics();
    expect(m.auditEventsSent).toBe(2);
    expect(m.governanceErrors).toBe(1);
  });

  it("returns a snapshot (not a live reference)", () => {
    const m1 = getMetrics();
    recordToolCallBlocked();
    const m2 = getMetrics();
    expect(m1.toolCallsBlocked).toBe(0);
    expect(m2.toolCallsBlocked).toBe(1);
  });

  it("resets all counters", () => {
    recordToolCallEvaluated();
    recordToolCallBlocked();
    recordMessageScanned();
    recordAuditEventSent();
    recordGovernanceError();

    resetMetrics();
    const m = getMetrics();
    expect(m.toolCallsEvaluated).toBe(0);
    expect(m.toolCallsBlocked).toBe(0);
    expect(m.messagesScanned).toBe(0);
    expect(m.auditEventsSent).toBe(0);
    expect(m.governanceErrors).toBe(0);
  });

  it("has a valid startedAt timestamp", () => {
    const m = getMetrics();
    const ts = new Date(m.startedAt);
    expect(ts.getTime()).not.toBeNaN();
    expect(ts.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
