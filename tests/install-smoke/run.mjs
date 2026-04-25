#!/usr/bin/env node
// Install-to-use smoke harness for the OpenClaw plugin (QF-17).
//
// Proves that the tarball produced by `npm pack` is a complete,
// installable artifact that — once dropped into a clean Node project
// — wires up an AxonFlowClient that can exchange the Plugin Batch 1
// richer-context response shape with an AxonFlow agent.
//
// Steps:
//   1. npm run build (in repo root)
//   2. npm pack       → axonflow-openclaw-X.Y.Z.tgz
//   3. Validate tarball file list (manifest, dist, policies, README,
//      CHANGELOG, LICENSE).
//   4. In a fresh tmp dir: npm init -y; npm install <tarball>.
//   5. Verify the installed manifest parses and exposes the expected
//      configSchema keys, and that dist/index.js exports
//      AxonFlowClient as a constructor.
//   6. Spawn the local stub-server on a random port.
//   7. Construct AxonFlowClient against the stub, fire a SQLi-bearing
//      mcpCheckInput, assert it's denied with decision_id, risk_level,
//      policy_matches, override_available (Plugin Batch 1 fields).
//   8. Fire a benign mcpCheckInput, assert allowed=true.
//   9. Tear down stub.
//
// Exit codes:
//   0  PASS
//   1  fail (assertion violated, install error, etc.)
//   2  setup error (missing build output, child process couldn't spawn)
//
// No external network access required: the stub-server runs locally
// on 127.0.0.1.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

let exitCode = 0;
const failures = [];
const fail = (msg) => {
  failures.push(msg);
  exitCode = 1;
  console.error(`FAIL: ${msg}`);
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: opts.silent ? 'pipe' : 'inherit',
    cwd: opts.cwd || REPO_ROOT,
    env: { ...process.env, DO_NOT_TRACK: '1', ...opts.env },
    encoding: 'utf8',
  });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`command failed: ${cmd} ${args.join(' ')} (status ${r.status})`);
    if (opts.silent) {
      if (r.stdout) console.error(r.stdout);
      if (r.stderr) console.error(r.stderr);
    }
    process.exit(2);
  }
  return r;
}

// ---------------------------------------------------------------
// 1. Build (idempotent — ok if dist/ already up to date).
// ---------------------------------------------------------------
console.log('--- Step 1: build ---');
run('npm', ['run', 'build']);
if (!existsSync(join(REPO_ROOT, 'dist', 'index.js'))) {
  console.error('dist/index.js missing after build');
  process.exit(2);
}

// ---------------------------------------------------------------
// 2. Pack tarball.
// ---------------------------------------------------------------
console.log('\n--- Step 2: npm pack ---');
const packDir = mkdtempSync(join(tmpdir(), 'openclaw-pack-'));
const pack = run('npm', ['pack', '--pack-destination', packDir, '--json'], {
  silent: true,
});
let tarballPath;
try {
  const meta = JSON.parse(pack.stdout);
  tarballPath = join(packDir, meta[0].filename);
} catch (e) {
  console.error('failed to parse `npm pack --json` output:', e.message);
  console.error(pack.stdout);
  process.exit(2);
}
if (!existsSync(tarballPath)) {
  console.error(`tarball not at expected path ${tarballPath}`);
  process.exit(2);
}
console.log(`packed: ${tarballPath}`);

// ---------------------------------------------------------------
// 3. Validate tarball file list.
// ---------------------------------------------------------------
console.log('\n--- Step 3: validate tarball contents ---');
const tarList = run('tar', ['-tzf', tarballPath], { silent: true }).stdout
  .split('\n')
  .filter(Boolean);
const required = [
  'package/package.json',
  'package/openclaw.plugin.json',
  'package/README.md',
  'package/CHANGELOG.md',
  'package/LICENSE',
  'package/dist/index.js',
  'package/dist/index.d.ts',
];
for (const f of required) {
  if (!tarList.includes(f)) fail(`tarball missing required file: ${f}`);
}
const hasPolicies = tarList.some((p) => p.startsWith('package/policies/'));
if (!hasPolicies) fail('tarball missing policies/ contents (declared in package.json files[])');
console.log(`tarball entries: ${tarList.length}`);

// ---------------------------------------------------------------
// 4. Install into a clean consumer dir.
// ---------------------------------------------------------------
console.log('\n--- Step 4: install in clean consumer dir ---');
const consumer = mkdtempSync(join(tmpdir(), 'openclaw-consumer-'));
writeFileSync(
  join(consumer, 'package.json'),
  JSON.stringify({ name: 'openclaw-install-smoke', private: true, type: 'module', version: '0.0.0' }, null, 2),
);
run('npm', ['install', tarballPath, '--silent', '--no-audit', '--no-fund'], {
  cwd: consumer,
  env: { npm_config_loglevel: 'warn' },
});
const installed = join(consumer, 'node_modules', '@axonflow', 'openclaw');
if (!existsSync(installed)) {
  fail(`installed package not at ${installed}`);
  printSummary();
  process.exit(exitCode);
}

// ---------------------------------------------------------------
// 5. Verify installed manifest + module shape.
// ---------------------------------------------------------------
console.log('\n--- Step 5: validate installed manifest + exports ---');
const manifestPath = join(installed, 'openclaw.plugin.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (e) {
  fail(`manifest unreadable: ${e.message}`);
}
if (manifest && manifest.id !== 'axonflow-governance') {
  fail(`manifest.id expected 'axonflow-governance', got ${JSON.stringify(manifest.id)}`);
}
if (manifest && (!manifest.configSchema || !manifest.configSchema.properties)) {
  fail('manifest.configSchema.properties missing');
}
if (manifest && manifest.configSchema && !manifest.configSchema.properties.endpoint) {
  fail('manifest.configSchema.properties.endpoint missing');
}

const installedEntry = join(installed, 'dist', 'index.js');
const mod = await import(installedEntry);
if (typeof mod.AxonFlowClient !== 'function') {
  fail(`AxonFlowClient export missing or not a constructor (got ${typeof mod.AxonFlowClient})`);
  printSummary();
  process.exit(exitCode);
}

// ---------------------------------------------------------------
// 6. Spawn the local stub agent.
// ---------------------------------------------------------------
console.log('\n--- Step 6: spawn stub agent ---');
const SMOKE_CLIENT_ID = 'smoke';
const SMOKE_CLIENT_SECRET = 'smoke';
const SMOKE_USER_EMAIL = 'smoke@example.com';
// Pre-compute the exact Basic auth header the AxonFlowClient should
// emit. The stub returns 401 if the inbound Authorization header
// doesn't match — i.e. if a regression drops, mangles, or omits the
// header, the harness's mcpCheckInput call below fails on the 401
// and the smoke goes red rather than silently passing against a
// permissive stub.
const expectedAuth =
  'Basic ' +
  Buffer.from(`${SMOKE_CLIENT_ID}:${SMOKE_CLIENT_SECRET}`).toString('base64');
const stubScript = join(__dirname, 'stub-server.mjs');
const stub = spawn(process.execPath, [stubScript], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'inherit'],
  env: {
    ...process.env,
    STUB_PORT: '0',
    STUB_EXPECTED_AUTH: expectedAuth,
    STUB_EXPECTED_USER_EMAIL: SMOKE_USER_EMAIL,
  },
});

const stubPort = await new Promise((resolveP, rejectP) => {
  const t = setTimeout(() => rejectP(new Error('stub did not announce port within 5s')), 5000);
  let buf = '';
  stub.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const m = buf.match(/STUB_LISTENING:(\d+)/);
    if (m) {
      clearTimeout(t);
      resolveP(Number(m[1]));
    }
  });
  stub.on('exit', (code) => {
    clearTimeout(t);
    rejectP(new Error(`stub exited prematurely with code ${code}`));
  });
});
console.log(`stub listening on 127.0.0.1:${stubPort}`);

const cleanup = () => {
  if (!stub.killed) stub.kill('SIGTERM');
  rmSync(packDir, { recursive: true, force: true });
  rmSync(consumer, { recursive: true, force: true });
};

try {
  // ---------------------------------------------------------------
  // 7. Deny case: SQLi statement → 403 with Plugin Batch 1 fields.
  // ---------------------------------------------------------------
  console.log('\n--- Step 7: deny case (SQLi) ---');
  const client = new mod.AxonFlowClient({
    endpoint: `http://127.0.0.1:${stubPort}`,
    clientId: SMOKE_CLIENT_ID,
    clientSecret: SMOKE_CLIENT_SECRET,
    userEmail: SMOKE_USER_EMAIL,
  });
  const deny = await client.mcpCheckInput(
    'postgresql',
    "SELECT * FROM users WHERE id='1' OR 1=1--",
    'query',
  );
  if (deny.allowed !== false) fail(`deny: expected allowed=false, got ${deny.allowed}`);
  if (!deny.decision_id) fail('deny: missing decision_id');
  if (!deny.risk_level) fail('deny: missing risk_level');
  if (!Array.isArray(deny.policy_matches) || deny.policy_matches.length === 0) {
    fail('deny: missing or empty policy_matches');
  }
  if (deny.override_available !== true) {
    fail(`deny: expected override_available=true, got ${deny.override_available}`);
  }
  console.log(
    `deny ok — allowed=${deny.allowed} risk=${deny.risk_level} matches=${deny.policy_matches?.length ?? 0}`,
  );

  // ---------------------------------------------------------------
  // 8. Allow case: benign statement → 200 allowed=true.
  // ---------------------------------------------------------------
  console.log('\n--- Step 8: allow case (benign) ---');
  const allow = await client.mcpCheckInput(
    'postgresql',
    'SELECT id, email FROM users LIMIT 10',
    'query',
  );
  if (allow.allowed !== true) fail(`allow: expected allowed=true, got ${allow.allowed}`);
  if (!allow.decision_id) fail('allow: missing decision_id');
  console.log(`allow ok — allowed=${allow.allowed} risk=${allow.risk_level}`);
} finally {
  cleanup();
}

printSummary();
process.exit(exitCode);

function printSummary() {
  console.log('');
  if (exitCode === 0) {
    console.log('PASS: install-smoke — tarball install + Plugin Batch 1 wire shape verified end-to-end');
  } else {
    console.error(`FAIL: install-smoke — ${failures.length} assertion(s) failed`);
    for (const f of failures) console.error(`  - ${f}`);
  }
}
