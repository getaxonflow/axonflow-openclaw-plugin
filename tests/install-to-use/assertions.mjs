// Shared response-shape assertions for the install-to-use smoke harness.
//
// Lives separately from run.mjs so the assertions can be unit-tested in
// isolation by verify-assertions-fail.mjs — proving the gate is not a
// no-op even before it runs against a live stack.

const ELEVATED_RISK_LEVELS = new Set(['high', 'critical']);

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
  if (typeof response.risk_level !== 'string' || response.risk_level.length === 0) {
    failures.push(`${label}: missing or empty risk_level`);
  } else if (!ELEVATED_RISK_LEVELS.has(response.risk_level)) {
    failures.push(
      `${label}: expected risk_level one of [${[...ELEVATED_RISK_LEVELS].join(', ')}], got ${JSON.stringify(response.risk_level)}`,
    );
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
  if (typeof response.decision_id !== 'string' || response.decision_id.length === 0) {
    failures.push(`${label}: missing or empty decision_id`);
  }
  return failures;
}

export function assertSqliDeny(response) {
  const failures = collectDenyFailures(response, 'sqli-deny');
  if (failures.length > 0) throw new AssertionFailures(failures);
}

export function assertBenignAllow(response) {
  const failures = collectAllowFailures(response, 'benign-allow');
  if (failures.length > 0) throw new AssertionFailures(failures);
}

export const __test = { collectDenyFailures, collectAllowFailures, ELEVATED_RISK_LEVELS };
