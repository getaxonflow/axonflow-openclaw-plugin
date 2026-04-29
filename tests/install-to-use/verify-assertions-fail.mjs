#!/usr/bin/env node
// Synthetic-failure proof for the install-to-use smoke gate.
//
// Feeds deliberately bad responses into the assertions module and proves
// each one throws. If a regression silently neuters an assertion (e.g.
// drops the decision_id check), this script exits non-zero — the gate
// cannot become a no-op without this synthetic-failure script also going
// red.
//
// Runs in CI as a separate step before the live-stack harness.

import { assertSqliDeny, assertBenignAllow, AssertionFailures } from './assertions.mjs';

let failures = 0;

function expectThrows(label, fn, mustMention) {
  try {
    fn();
  } catch (err) {
    if (!(err instanceof AssertionFailures)) {
      console.error(`FAIL: ${label} — threw unexpected error type ${err?.constructor?.name}: ${err?.message}`);
      failures++;
      return;
    }
    const joined = err.failures.join('\n');
    if (mustMention && !joined.includes(mustMention)) {
      console.error(`FAIL: ${label} — failure list missing expected mention "${mustMention}":\n${joined}`);
      failures++;
      return;
    }
    console.log(`pass: ${label} — threw with ${err.failures.length} failure(s)`);
    return;
  }
  console.error(`FAIL: ${label} — assertion did NOT throw on bad input (gate would silently pass)`);
  failures++;
}

function expectNoThrow(label, fn) {
  try {
    fn();
    console.log(`pass: ${label} — passed cleanly on good input`);
  } catch (err) {
    console.error(`FAIL: ${label} — assertion threw on a valid response: ${err?.message}`);
    if (err?.failures) {
      for (const f of err.failures) console.error(`  - ${f}`);
    }
    failures++;
  }
}

const goodDeny = {
  allowed: false,
  decision_id: 'dec-deadbeef',
  risk_level: 'high',
  policy_matches: [{ id: 'sql-injection', name: 'SQL Injection' }],
  override_available: true,
};

const goodAllow = {
  allowed: true,
  decision_id: 'dec-cafebabe',
  risk_level: 'low',
};

// Positive: well-formed responses pass.
expectNoThrow('deny: well-formed response passes', () => assertSqliDeny(goodDeny));
expectNoThrow('allow: well-formed response passes', () => assertBenignAllow(goodAllow));

// Synthetic failures — every assertion line must reject its bad input.
expectThrows('deny: rejects allowed=true (would let SQLi through)', () => {
  assertSqliDeny({ ...goodDeny, allowed: true });
}, 'allowed=false');

function omit(obj, key) {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

expectThrows('deny: rejects missing decision_id', () => {
  assertSqliDeny(omit(goodDeny, 'decision_id'));
}, 'decision_id');

expectThrows('deny: rejects empty decision_id', () => {
  assertSqliDeny({ ...goodDeny, decision_id: '' });
}, 'decision_id');

expectThrows('deny: rejects missing risk_level', () => {
  assertSqliDeny(omit(goodDeny, 'risk_level'));
}, 'risk_level');

expectThrows('deny: rejects risk_level=low (must be elevated)', () => {
  assertSqliDeny({ ...goodDeny, risk_level: 'low' });
}, 'risk_level');

expectThrows('deny: rejects empty policy_matches array', () => {
  assertSqliDeny({ ...goodDeny, policy_matches: [] });
}, 'policy_matches');

expectThrows('deny: rejects missing policy_matches', () => {
  assertSqliDeny(omit(goodDeny, 'policy_matches'));
}, 'policy_matches');

expectThrows('deny: rejects null response', () => assertSqliDeny(null), 'not an object');

// Type-violation coverage: the assertions also reject responses where a
// field is the wrong shape (number where string expected, object where
// array expected). Without these the synthetic-failure proof would be
// silent on the typeof / Array.isArray branches.
expectThrows('deny: rejects non-string decision_id (number)', () => {
  assertSqliDeny({ ...goodDeny, decision_id: 42 });
}, 'decision_id');

expectThrows('deny: rejects non-string risk_level (number)', () => {
  assertSqliDeny({ ...goodDeny, risk_level: 5 });
}, 'risk_level');

expectThrows('deny: rejects empty-string risk_level', () => {
  assertSqliDeny({ ...goodDeny, risk_level: '' });
}, 'risk_level');

expectThrows('deny: rejects non-array policy_matches (object)', () => {
  assertSqliDeny({ ...goodDeny, policy_matches: { count: 1 } });
}, 'policy_matches');

expectThrows('deny: rejects non-array policy_matches (string)', () => {
  assertSqliDeny({ ...goodDeny, policy_matches: 'sql-injection' });
}, 'policy_matches');

expectThrows('deny: rejects array response (typeof "object" but not a plain object)', () => {
  assertSqliDeny([]);
}, 'allowed=false');

expectThrows('deny: rejects empty-string response', () => assertSqliDeny(''), 'not an object');

expectThrows('allow: rejects allowed=false', () => {
  assertBenignAllow({ ...goodAllow, allowed: false });
}, 'allowed=true');

expectThrows('allow: rejects truthy non-true (number 1)', () => {
  assertBenignAllow({ ...goodAllow, allowed: 1 });
}, 'allowed=true');

expectThrows('allow: rejects null response', () => assertBenignAllow(null), 'not an object');

// allow: decision_id is intentionally NOT asserted in production today —
// see the comment in assertions.mjs (axonflow-enterprise#1746). When the
// platform fix ships, set STRICT_DECISION_ID_ON_ALLOW=1 to enforce the
// decision_id presence check on the allow path. The verifier exercises
// both modes so the strict path doesn't bit-rot while waiting.
process.env.STRICT_DECISION_ID_ON_ALLOW = '1';
expectThrows(
  'allow (strict): rejects missing decision_id when STRICT_DECISION_ID_ON_ALLOW=1',
  () => assertBenignAllow(omit(goodAllow, 'decision_id')),
  'decision_id',
);
expectThrows(
  'allow (strict): rejects empty decision_id when STRICT_DECISION_ID_ON_ALLOW=1',
  () => assertBenignAllow({ ...goodAllow, decision_id: '' }),
  'decision_id',
);
expectThrows(
  'allow (strict): rejects non-string decision_id when STRICT_DECISION_ID_ON_ALLOW=1',
  () => assertBenignAllow({ ...goodAllow, decision_id: 42 }),
  'decision_id',
);
delete process.env.STRICT_DECISION_ID_ON_ALLOW;

if (failures > 0) {
  console.error(`\nFAIL: ${failures} synthetic-failure check(s) did not behave as required.`);
  console.error('The install-to-use smoke gate would be a silent no-op.');
  process.exit(1);
}
console.log('\nPASS: all synthetic-failure checks rejected bad input — gate is not a no-op.');
