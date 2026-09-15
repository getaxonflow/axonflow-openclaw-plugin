// Shared response-shape assertions for the install-to-use smoke harness.
//
// Lives separately from run.mjs so the assertions can be unit-tested in
// isolation by verify-assertions-fail.mjs — proving the gate is not a
// no-op even before it runs against a live stack.

export class AssertionFailures extends Error {
  constructor(failures) {
    super(`assertion(s) failed: ${failures.length}`);
    this.failures = failures;
  }
}

function collectDenyFailures(response, label = 'deny') {
  const failures = [];
  if (response == null || typeof response !== 'object') {
    failures.push(`${label}: response is not an object (got ${typeof response})`);
    return failures;
  }
  if (response.allowed !== false) {
    failures.push(`${label}: expected allowed=false, got ${JSON.stringify(response.allowed)}`);
  }
  if (typeof response.decision_id !== 'string' || response.decision_id.length === 0) {
    failures.push(`${label}: missing or empty decision_id`);
  }
  // A deny names its reason. risk_level is not asserted: from AxonFlow
  // v11.0.0 a check-input deny carries no risk_level (measured on a v11
  // community stack: allowed, block_reason, decision_id, policy_matches).
  if (typeof response.block_reason !== 'string' || response.block_reason.length === 0) {
    failures.push(`${label}: missing or empty block_reason`);
  }
  if (!Array.isArray(response.policy_matches) || response.policy_matches.length === 0) {
    failures.push(`${label}: missing or empty policy_matches`);
  }
  return failures;
}

function collectAllowFailures(response, label = 'allow') {
  const failures = [];
  if (response == null || typeof response !== 'object') {
    failures.push(`${label}: response is not an object (got ${typeof response})`);
    return failures;
  }
  if (response.allowed !== true) {
    failures.push(`${label}: expected allowed=true, got ${JSON.stringify(response.allowed)}`);
  }
  // decision_id is opt-in on the allow path. The community stack omits
  // it on allow today (axonflow-enterprise#1746); the deny-side
  // assertion is the single source of truth for decision_id presence
  // until that ships. STRICT_DECISION_ID_ON_ALLOW=1 is the forcing
  // flag — when the platform fix lands, set the env var in CI and
  // this branch makes the assertion strict on the allow path too,
  // surfacing any regression that drops decision_id again.
  if (process.env.STRICT_DECISION_ID_ON_ALLOW === '1') {
    if (typeof response.decision_id !== 'string' || response.decision_id.length === 0) {
      failures.push(`${label}: missing or empty decision_id (STRICT_DECISION_ID_ON_ALLOW=1)`);
    }
  }
  return failures;
}

export function assertPolicyDeny(response) {
  const failures = collectDenyFailures(response, 'policy-deny');
  if (failures.length > 0) throw new AssertionFailures(failures);
}

export function assertBenignAllow(response) {
  const failures = collectAllowFailures(response, 'benign-allow');
  if (failures.length > 0) throw new AssertionFailures(failures);
}

export const __test = { collectDenyFailures, collectAllowFailures };
