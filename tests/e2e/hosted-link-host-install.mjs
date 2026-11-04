#!/usr/bin/env node
// Exercise the README link command after a real OpenClaw install of a packed archive.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const archive = process.argv[2] && resolve(process.argv[2]);
assert(archive && existsSync(archive), 'usage: node hosted-link-host-install.mjs <packed.tgz>');
const root = mkdtempSync(join(tmpdir(), 'axonflow-openclaw-link-host-'));
const state = join(root, 'state');
const env = {
  ...process.env,
  OPENCLAW_STATE_DIR: state,
  AXONFLOW_CONFIG_DIR: join(root, 'axonflow-config'),
  AXONFLOW_CACHE_DIR: join(root, 'axonflow-cache'),
  AXONFLOW_TELEMETRY: 'off',
};
function run(command, args) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout + result.stderr;
}

try {
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  run('openclaw', ['plugins', 'install', archive, '--force']);
  const installed = join(state, 'extensions', 'axonflow-governance', 'bin', 'axonflow-openclaw-link.mjs');
  assert(existsSync(installed), 'OpenClaw did not install the link script at the documented extension path');
  const help = run('bash', ['--noprofile', '--norc', '-c',
    'node "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/extensions/axonflow-governance/bin/axonflow-openclaw-link.mjs" --help']);
  assert.match(help, /Usage: axonflow-openclaw-link/);
  const statusHelp = run('bash', ['--noprofile', '--norc', '-c',
    'node "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/extensions/axonflow-governance/bin/axonflow-openclaw-status.mjs" --help']);
  assert.match(statusHelp, /axonflow-openclaw-status/);
  const recoverHelp = run('bash', ['--noprofile', '--norc', '-c',
    'node "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/extensions/axonflow-governance/bin/axonflow-openclaw-recover.mjs" --help']);
  assert.match(recoverHelp, /axonflow-openclaw-recover/);
  const flow = spawnSync(process.execPath, [fileURLToPath(new URL('./hosted-link-cli-smoke.mjs', import.meta.url))], {
    env: { ...env, AXONFLOW_LINK_CLI_PATH: installed }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(flow.status, 0, `installed link flow failed:\n${flow.stderr}\n${flow.stdout}`);
  process.stdout.write(`PASS: installed OpenClaw archive ${digest}; documented commands and isolated device-link flow work\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
