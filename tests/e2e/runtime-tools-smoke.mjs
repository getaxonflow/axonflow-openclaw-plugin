// Plugin runtime E2E: agent-callable tools (W2)
//
// Loads the built plugin, captures the 5 tool definitions OpenClaw would
// see via `api.registerTool`, and invokes each tool's `execute()` —
// the same code path OpenClaw's tool dispatcher uses when an agent
// invokes the tool — against a live AxonFlow stack.
//
// This satisfies the "MUST invoke through the runtime, NOT by importing
// the AxonFlow client class directly" gate: nothing in this script
// imports AxonFlowClient. We exercise the plugin's registered tool
// surface end-to-end.
//
// Usage (from repo root, after `npm ci && npm run build`):
//   AXONFLOW_ENDPOINT=http://localhost:8080 \
//   AXONFLOW_CLIENT_ID=demo-client \
//   AXONFLOW_CLIENT_SECRET=demo-secret \
//     node tests/e2e/runtime-tools-smoke.mjs
//
// Exits 0 with a "SKIP:" message when the stack isn't reachable so the
// script is safe to run anywhere (CI, local dev, or against a torn-down
// stack).

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

const plugin = await import('../../dist/index.js');
const registerAxonFlowGovernance = plugin.default?.register;
if (typeof registerAxonFlowGovernance !== 'function') {
  console.error('ERROR: plugin default export does not expose .register');
  process.exit(2);
}

const ENDPOINT = process.env.AXONFLOW_ENDPOINT || 'http://localhost:8080';
const CLIENT_ID = process.env.AXONFLOW_CLIENT_ID || 'demo-client';
const CLIENT_SECRET = process.env.AXONFLOW_CLIENT_SECRET || 'demo-secret';

try {
  const r = await fetch(`${ENDPOINT}/health`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`health ${r.status}`);
} catch (e) {
  console.log(`SKIP: AxonFlow stack not reachable at ${ENDPOINT}/health (${e.message})`);
  console.log('      Start one via axonflow-enterprise scripts/setup-e2e-testing.sh');
  process.exit(0);
}

// ─── Mock OpenClaw plugin API surface ──────────────────────────────────
// We record every registerTool/on call the plugin makes so we can drive
// each tool's execute() ourselves (the same path the OpenClaw tool
// dispatcher uses).

const registeredTools = new Map();
const logs = [];

const api = {
  pluginConfig: {
    endpoint: ENDPOINT,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    userEmail: 'runtime-e2e@example.com',
  },
  logger: {
    info: (msg) => logs.push(['info', msg]),
    warn: (msg) => logs.push(['warn', msg]),
    error: (msg) => logs.push(['error', msg]),
  },
  on: () => {},
  registerTool: (tool) => {
    if (!tool || typeof tool.name !== 'string' || typeof tool.execute !== 'function') {
      throw new Error('registerTool received malformed tool definition');
    }
    if (registeredTools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    registeredTools.set(tool.name, tool);
  },
};

registerAxonFlowGovernance(api);

const expectedNames = [
  'axonflow_audit_search',
  'axonflow_explain_decision',
  'axonflow_list_overrides',
  'axonflow_create_override',
  'axonflow_revoke_override',
];

let errors = 0;
for (const name of expectedNames) {
  if (!registeredTools.has(name)) {
    console.error(`FAIL: tool ${name} was not registered`);
    errors++;
  }
}
if (registeredTools.size !== expectedNames.length) {
  console.error(`FAIL: expected ${expectedNames.length} tools registered, got ${registeredTools.size}`);
  errors++;
}
if (errors > 0) {
  console.error('FAIL: tool registration check failed');
  process.exit(1);
}

console.log(`Registered ${registeredTools.size} tools: ${[...registeredTools.keys()].join(', ')}`);

// ─── Execute each tool through the runtime path ─────────────────────────

async function exec(name, args) {
  const tool = registeredTools.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.execute(`${name}-call-1`, args);
}

let scenarioErrors = 0;

// 1) audit_search — should return entries array (may be empty on a fresh stack)
console.log('--- 1/5 axonflow_audit_search ---');
{
  const r = await exec('axonflow_audit_search', { limit: 5 });
  if (r.isError) {
    console.error('FAIL: audit_search returned isError:', r.content[0]?.text);
    scenarioErrors++;
  } else {
    const d = r.details;
    if (!Array.isArray(d?.entries)) {
      console.error('FAIL: audit_search response missing entries[]:', JSON.stringify(d));
      scenarioErrors++;
    } else {
      console.log(`PASS: audit_search returned entries array (${d.entries.length} items, total=${d.total})`);
    }
  }
}

// 2) list_overrides — should return overrides + count (may be empty)
console.log('--- 2/5 axonflow_list_overrides ---');
{
  const r = await exec('axonflow_list_overrides', {});
  if (r.isError) {
    console.error('FAIL: list_overrides returned isError:', r.content[0]?.text);
    scenarioErrors++;
  } else {
    const d = r.details;
    if (!Array.isArray(d?.overrides) || typeof d?.count !== 'number') {
      console.error('FAIL: list_overrides response missing overrides[]/count:', JSON.stringify(d));
      scenarioErrors++;
    } else {
      console.log(`PASS: list_overrides returned ${d.count} overrides`);
    }
  }
}

// 3) create_override — validation rejection should NOT call the server
console.log('--- 3/5 axonflow_create_override (validation) ---');
{
  const r = await exec('axonflow_create_override', {
    policy_id: 'sys_sqli_v1',
    policy_type: 'static',
    // override_reason intentionally omitted to verify client-side validation
  });
  if (!r.isError || !r.content[0]?.text.includes('override_reason is required')) {
    console.error('FAIL: create_override should reject missing override_reason:', JSON.stringify(r));
    scenarioErrors++;
  } else {
    console.log('PASS: create_override rejected missing override_reason without hitting server');
  }
}

// 4) explain_decision — empty decision_id → client-side rejection
console.log('--- 4/5 axonflow_explain_decision (validation) ---');
{
  const r = await exec('axonflow_explain_decision', {});
  if (!r.isError || !r.content[0]?.text.includes('decision_id is required')) {
    console.error('FAIL: explain_decision should reject empty decision_id:', JSON.stringify(r));
    scenarioErrors++;
  } else {
    console.log('PASS: explain_decision rejected empty decision_id');
  }
}

// 5) revoke_override — empty override_id → client-side rejection
console.log('--- 5/5 axonflow_revoke_override (validation) ---');
{
  const r = await exec('axonflow_revoke_override', {});
  if (!r.isError || !r.content[0]?.text.includes('override_id is required')) {
    console.error('FAIL: revoke_override should reject empty override_id:', JSON.stringify(r));
    scenarioErrors++;
  } else {
    console.log('PASS: revoke_override rejected empty override_id');
  }
}

if (scenarioErrors > 0) {
  console.error(`FAIL: ${scenarioErrors} tool scenarios failed`);
  process.exit(1);
}

console.log('PASS: runtime-tools-smoke — all 5 tools registered and dispatch correctly');
