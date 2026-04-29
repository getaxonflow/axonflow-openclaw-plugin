#!/usr/bin/env node
// Install-to-use smoke harness against a live AxonFlow community stack.
//
// Differs from tests/install-smoke/run.mjs (which uses a stub) by driving
// the freshly-tarballed plugin against a real docker-compose deployment.
// This catches regressions where the plugin installs cleanly and exposes
// the right wire shape against a stub but the real agent's policy engine,
// MCP routes, or plugin-batch-1 fields disagree with what the SDK expects.
//
// Required env:
//   AXONFLOW_ENDPOINT       agent base URL (e.g. http://localhost:8080)
//   AXONFLOW_CLIENT_ID      tenant client id seeded in the stack
//   AXONFLOW_CLIENT_SECRET  tenant client secret seeded in the stack
//
// Steps:
//   1. Build (npm run build).
//   2. npm pack → tarball.
//   3. Install tarball into a clean tmp consumer dir.
//   4. Probe ${AXONFLOW_ENDPOINT}/health — fail fast if the stack
//      isn't up; the workflow is responsible for spinning it up.
//   5. Construct AxonFlowClient from the installed tarball + fire a
//      canonical SQLi-bearing mcpCheckInput. Assert deny shape.
//   6. Fire a benign mcpCheckInput. Assert allow shape.
//   7. Tear down tmp dirs.
//
// Exit codes:
//   0  PASS
//   1  assertion failure / health probe failure (gate fires)
//   2  setup error (couldn't build / pack / install — bug in the
//      harness or the workflow, not in the plugin)

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertSqliDeny, assertBenignAllow, AssertionFailures } from './assertions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const ENDPOINT = process.env.AXONFLOW_ENDPOINT;
const CLIENT_ID = process.env.AXONFLOW_CLIENT_ID;
const CLIENT_SECRET = process.env.AXONFLOW_CLIENT_SECRET;
const USER_EMAIL = process.env.AXONFLOW_USER_EMAIL || 'install-to-use-smoke@example.com';

if (!ENDPOINT || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('FAIL: required env not set: AXONFLOW_ENDPOINT, AXONFLOW_CLIENT_ID, AXONFLOW_CLIENT_SECRET');
  process.exit(2);
}

let exitCode = 0;
let packDir;
let consumer;

function setupFail(msg, err) {
  console.error(`SETUP-FAIL: ${msg}`);
  if (err) console.error(err);
  cleanup();
  process.exit(2);
}

function cleanup() {
  for (const dir of [packDir, consumer]) {
    if (dir && existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.error(`cleanup warning: ${err.message}`);
      }
    }
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: opts.silent ? 'pipe' : 'inherit',
    cwd: opts.cwd || REPO_ROOT,
    env: { ...process.env, DO_NOT_TRACK: '1', ...(opts.env || {}) },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    if (opts.silent) {
      if (r.stdout) console.error(r.stdout);
      if (r.stderr) console.error(r.stderr);
    }
    setupFail(`command failed: ${cmd} ${args.join(' ')} (status ${r.status})`);
  }
  return r;
}

console.log(`--- install-to-use smoke against ${ENDPOINT} ---`);

console.log('\nstep 1: build');
run('npm', ['run', 'build']);
if (!existsSync(join(REPO_ROOT, 'dist', 'index.js'))) {
  setupFail('dist/index.js missing after build');
}

console.log('\nstep 2: npm pack');
packDir = mkdtempSync(join(tmpdir(), 'openclaw-pack-'));
const pack = run('npm', ['pack', '--pack-destination', packDir, '--json'], {
  silent: true,
});
let tarballPath;
try {
  const meta = JSON.parse(pack.stdout);
  tarballPath = join(packDir, meta[0].filename);
} catch (err) {
  setupFail('failed to parse `npm pack --json` output', err);
}
if (!existsSync(tarballPath)) {
  setupFail(`tarball not at expected path ${tarballPath}`);
}
console.log(`packed: ${tarballPath}`);

console.log('\nstep 3: install in clean consumer dir');
consumer = mkdtempSync(join(tmpdir(), 'openclaw-consumer-'));
writeFileSync(
  join(consumer, 'package.json'),
  JSON.stringify(
    { name: 'install-to-use-smoke', private: true, type: 'module', version: '0.0.0' },
    null,
    2,
  ),
);
run('npm', ['install', tarballPath, '--silent', '--no-audit', '--no-fund'], {
  cwd: consumer,
  env: { npm_config_loglevel: 'warn' },
});
const installed = join(consumer, 'node_modules', '@axonflow', 'openclaw');
if (!existsSync(installed)) {
  setupFail(`installed package not at ${installed}`);
}

const installedManifestPath = join(installed, 'openclaw.plugin.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(installedManifestPath, 'utf8'));
} catch (err) {
  setupFail(`installed manifest unreadable: ${err.message}`);
}
if (manifest.id !== 'axonflow-governance') {
  setupFail(`installed manifest.id expected 'axonflow-governance', got ${JSON.stringify(manifest.id)}`);
}

console.log('\nstep 4: probe live stack /health');
try {
  const r = await fetch(`${ENDPOINT}/health`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) {
    console.error(`FAIL: ${ENDPOINT}/health returned ${r.status}`);
    cleanup();
    process.exit(1);
  }
} catch (err) {
  console.error(`FAIL: ${ENDPOINT}/health unreachable: ${err.message}`);
  cleanup();
  process.exit(1);
}

console.log('\nstep 5: construct client + fire SQLi (canonical deny scenario)');
const installedEntry = join(installed, 'dist', 'index.js');
const mod = await import(installedEntry);
if (typeof mod.AxonFlowClient !== 'function') {
  setupFail(`installed AxonFlowClient export missing or not a constructor`);
}

const client = new mod.AxonFlowClient({
  endpoint: ENDPOINT,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  userEmail: USER_EMAIL,
});

const denyResp = await client.mcpCheckInput(
  'postgresql',
  "SELECT * FROM users WHERE id='1' OR 1=1--",
  'query',
);
console.log(
  `deny response — allowed=${denyResp.allowed} decision_id=${denyResp.decision_id} risk=${denyResp.risk_level} matches=${(denyResp.policy_matches || []).length}`,
);
try {
  assertSqliDeny(denyResp);
  console.log('PASS: SQLi denied with elevated risk + policy matches');
} catch (err) {
  if (err instanceof AssertionFailures) {
    console.error('FAIL: SQLi deny scenario:');
    for (const f of err.failures) console.error(`  - ${f}`);
    exitCode = 1;
  } else {
    throw err;
  }
}

console.log('\nstep 6: fire benign mcpCheckInput (positive allow case)');
const allowResp = await client.mcpCheckInput(
  'postgresql',
  'SELECT id, email FROM users LIMIT 10',
  'query',
);
console.log(
  `allow response — allowed=${allowResp.allowed} decision_id=${allowResp.decision_id} risk=${allowResp.risk_level}`,
);
try {
  assertBenignAllow(allowResp);
  console.log('PASS: benign query allowed');
} catch (err) {
  if (err instanceof AssertionFailures) {
    console.error('FAIL: benign allow scenario:');
    for (const f of err.failures) console.error(`  - ${f}`);
    exitCode = 1;
  } else {
    throw err;
  }
}

cleanup();

if (exitCode === 0) {
  console.log('\nPASS: install-to-use smoke — fresh tarball governs traffic against live stack');
} else {
  console.error('\nFAIL: install-to-use smoke');
}
process.exit(exitCode);
