// Plugin smoke E2E: install-and-use sanity check against a live AxonFlow
// stack. Uses the plugin's own AxonFlowClient to fire a SQLi-bearing
// mcpCheckInput and asserts the response carries Plugin Batch 1
// richer-context fields (decision_id, risk_level, policy_matches,
// override_available).
//
// Scope: smoke-only — client wiring + one local deny response shape.
// The full install-and-use matrix (explain, override lifecycle, audit
// filter parity, cache invalidation) lives alongside the platform in
// axonflow-enterprise/tests/e2e/plugin-batch-1/openclaw-install/.
//
// Usage (from repo root, after `npm ci && npm run build`):
//   AXONFLOW_ENDPOINT=http://localhost:8080 \
//   AXONFLOW_CLIENT_ID=demo-client \
//   AXONFLOW_CLIENT_SECRET=demo-secret \
//     node tests/e2e/smoke-block-context.mjs
//
// CI trigger: workflow_dispatch only (GitHub-hosted runners have no
// local stack; PR gating needs a self-hosted runner).
// Exits 0 with a "SKIP:" message when the stack isn't reachable so the
// script is safe to run anywhere.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(__dirname, '..', '..', 'dist', 'index.js');
if (!existsSync(distEntry)) {
  console.error(`ERROR: ${distEntry} not found.`);
  console.error('       Build the plugin first: npm ci && npm run build');
  process.exit(2);
}

const { AxonFlowClient } = await import('../../dist/index.js');

const ENDPOINT = process.env.AXONFLOW_ENDPOINT || 'http://localhost:8080';
const CLIENT_ID = process.env.AXONFLOW_CLIENT_ID || 'demo-client';
const CLIENT_SECRET = process.env.AXONFLOW_CLIENT_SECRET || 'demo-secret';
const USER_EMAIL = 'e2e-smoke@example.com';

try {
  const r = await fetch(`${ENDPOINT}/health`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`health ${r.status}`);
} catch (e) {
  console.log(`SKIP: AxonFlow stack not reachable at ${ENDPOINT}/health (${e.message})`);
  console.log('      Start one via axonflow-enterprise scripts/setup-e2e-testing.sh');
  process.exit(0);
}

const client = new AxonFlowClient({
  endpoint: ENDPOINT,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  userEmail: USER_EMAIL,
});

console.log(`--- Firing check-input: "' OR 1=1 --" (should deny) ---`);
const result = await client.mcpCheckInput(
  'postgresql',
  "SELECT * FROM users WHERE id='1' OR 1=1--",
  'query',
);

console.log('allowed           :', result.allowed);
console.log('block_reason      :', result.block_reason);
console.log('decision_id       :', result.decision_id);
console.log('risk_level        :', result.risk_level);
console.log('override_available:', result.override_available);

let errors = 0;
if (result.allowed !== false) {
  console.error('FAIL: expected allowed=false, got', result.allowed);
  errors++;
}
if (!result.decision_id) {
  console.error('FAIL: response missing decision_id (Plugin Batch 1 richer context)');
  errors++;
}
if (!result.risk_level) {
  console.error('FAIL: response missing risk_level (Plugin Batch 1 richer context)');
  errors++;
}
if (!Array.isArray(result.policy_matches) || result.policy_matches.length === 0) {
  console.error('FAIL: response missing or empty policy_matches (Plugin Batch 1 richer context)');
  errors++;
}

if (errors > 0) {
  console.error(`FAIL: smoke scenario failed with ${errors} error(s)`);
  process.exit(1);
}
console.log('PASS: smoke — OpenClaw client mcpCheckInput denies SQLi with richer context');
