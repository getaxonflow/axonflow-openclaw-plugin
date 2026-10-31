import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'axonflow-hosted-link-'));
try {
  const preload = join(root, 'preload.mjs');
  writeFileSync(preload, `
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, Math.min(ms, 1), ...args);
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/device/start')) return new Response(JSON.stringify({
        device_code: 'a'.repeat(64), user_code: 'ABCDEFG234', expires_in: 900,
      }), {status: 201});
      if (String(url).endsWith('/device/poll')) return new Response(JSON.stringify({
        status: 'approved', tenant_id: 'cs_00000000-0000-4000-8000-000000000001',
        expires_at: '2030-01-01T00:00:00Z',
      }), {status: 200});
      throw new Error('unexpected request');
    };
  `);
  const bin = resolve('bin/axonflow-openclaw-link.mjs');
  const env = { ...process.env, AXONFLOW_CONFIG_DIR: join(root, 'config') };
  const run = (...args) => spawnSync(process.execPath, ['--import', preload, bin, ...args],
    { env, encoding: 'utf8', timeout: 10_000 });
  const mismatched = run('--portal', 'https://portal.staging.example.test');
  if (mismatched.status !== 1 || !mismatched.stderr.includes('both --portal and --endpoint')) {
    throw new Error('staging Portal without matching endpoint was accepted');
  }
  const first = run();
  if (first.status !== 0 || !first.stdout.includes('Client linked.')) {
    throw new Error(`first link failed: ${first.stderr}`);
  }
  const file = join(env.AXONFLOW_CONFIG_DIR, 'try-registration.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  if (saved.tenant_id !== 'cs_00000000-0000-4000-8000-000000000001' ||
      saved.expires_at !== '2030-01-01T00:00:00Z' ||
      !/^[0-9a-f]{64}$/.test(saved.secret) || (statSync(file).mode & 0o777) !== 0o600 ||
      first.stdout.includes(saved.secret)) {
    throw new Error('linked credential not stored securely or leaked to stdout');
  }
  const second = run();
  if (second.status !== 1 || !second.stderr.includes('Use --replace')) {
    throw new Error('existing credential was overwritten without --replace');
  }
  process.stdout.write('PASS hosted-link-cli-smoke\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
