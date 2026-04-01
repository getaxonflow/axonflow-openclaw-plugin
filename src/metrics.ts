/**
 * In-process governance metrics counter.
 *
 * Tracks tool calls blocked, allowed, approved, messages cancelled/redacted,
 * and audit events since plugin initialization. Not persisted — resets on
 * process restart. Accessible via getMetrics() for debugging and monitoring.
 */

export interface GovernanceMetrics {
  /** Total tool calls evaluated by before_tool_call */
  toolCallsEvaluated: number;
  /** Tool calls blocked by policy */
  toolCallsBlocked: number;
  /** Tool calls that required approval (highRiskTools) */
  toolCallsApprovalRequired: number;
  /** Tool calls allowed through */
  toolCallsAllowed: number;
  /** Outbound messages scanned by message_sending */
  messagesScanned: number;
  /** Messages cancelled (blocked or AxonFlow unreachable with onError=block) */
  messagesCancelled: number;
  /** Messages redacted (PII/secrets found) */
  messagesRedacted: number;
  /** Audit events sent (after_tool_call + llm_output) */
  auditEventsSent: number;
  /** Errors during governance checks (AxonFlow unreachable, etc.) */
  governanceErrors: number;
  /** Plugin start timestamp */
  startedAt: string;
}

let metrics: GovernanceMetrics = createFreshMetrics();

function createFreshMetrics(): GovernanceMetrics {
  return {
    toolCallsEvaluated: 0,
    toolCallsBlocked: 0,
    toolCallsApprovalRequired: 0,
    toolCallsAllowed: 0,
    messagesScanned: 0,
    messagesCancelled: 0,
    messagesRedacted: 0,
    auditEventsSent: 0,
    governanceErrors: 0,
    startedAt: new Date().toISOString(),
  };
}

export function recordToolCallEvaluated(): void {
  metrics.toolCallsEvaluated++;
}

export function recordToolCallBlocked(): void {
  metrics.toolCallsBlocked++;
}

export function recordToolCallApprovalRequired(): void {
  metrics.toolCallsApprovalRequired++;
}

export function recordToolCallAllowed(): void {
  metrics.toolCallsAllowed++;
}

export function recordMessageScanned(): void {
  metrics.messagesScanned++;
}

export function recordMessageCancelled(): void {
  metrics.messagesCancelled++;
}

export function recordMessageRedacted(): void {
  metrics.messagesRedacted++;
}

export function recordAuditEventSent(): void {
  metrics.auditEventsSent++;
}

export function recordGovernanceError(): void {
  metrics.governanceErrors++;
}

/** Get a snapshot of current governance metrics. */
export function getMetrics(): Readonly<GovernanceMetrics> {
  return { ...metrics };
}

/** Reset all counters (for testing). */
export function resetMetrics(): void {
  metrics = createFreshMetrics();
}
