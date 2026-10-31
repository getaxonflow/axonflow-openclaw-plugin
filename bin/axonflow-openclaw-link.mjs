#!/usr/bin/env node
// Link this client to a paid Hosted account without copying a secret from the browser.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync, chmodSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { axonflowConfigDir } from '../dist/cache-dir.js';

const defaultPortal = 'https://portal.try.getaxonflow.com';
const defaultAgent = 'https://try.getaxonflow.com';

function origin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('A secure HTTPS origin is required');
  }
  return parsed.origin;
}

async function post(url, value) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok && response.status !== 202) {
    throw new Error(`Link request failed (${response.status})`);
  }
  return { status: response.status, body: await response.json() };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Usage: axonflow-openclaw-link [--portal HTTPS_ORIGIN --endpoint HTTPS_ORIGIN] [--replace]\n');
    return;
  }
  let portal = defaultPortal;
  let endpoint = defaultAgent;
  let explicitPortal = false;
  let explicitEndpoint = false;
  let replace = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--portal' && args[i + 1]) { portal = args[++i]; explicitPortal = true; }
    else if (args[i] === '--endpoint' && args[i + 1]) { endpoint = args[++i]; explicitEndpoint = true; }
    else if (args[i] === '--replace') replace = true;
    else throw new Error('Unknown or incomplete option');
  }
  if (explicitPortal !== explicitEndpoint) throw new Error('Specify both --portal and --endpoint for a nondefault environment');
  portal = origin(portal);
  endpoint = origin(endpoint);
  const configDir = axonflowConfigDir();
  if (!configDir) throw new Error('No secure AxonFlow config directory is available');
  const destination = join(configDir, 'try-registration.json');
  if (existsSync(destination) && !replace) {
    throw new Error('A client credential already exists. Use --replace to switch this installation to a new link.');
  }
  const secret = randomBytes(32).toString('hex');
  const started = await post(`${portal}/api/v1/auth/hosted/device/start`, { secret });
  if (started.status !== 201 || !/^[0-9a-f]{64}$/.test(started.body.device_code) ||
      !/^[A-Z2-7]{10}$/.test(started.body.user_code)) {
    throw new Error('Link service returned an invalid code');
  }
  process.stdout.write(`Open ${portal}/hosted/start?link=1 and enter code ${started.body.user_code}.\nWaiting for approval...\n`);
  const deadline = Date.now() + Math.min(Number(started.body.expires_in) || 900, 900) * 1000 + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const result = await post(`${portal}/api/v1/auth/hosted/device/poll`, { device_code: started.body.device_code });
    if (result.status === 202) continue;
    if (result.body.status !== 'approved' || !/^cs_[0-9a-f-]{36}$/.test(result.body.tenant_id) ||
        typeof result.body.expires_at !== 'string' || Date.parse(result.body.expires_at) <= Date.now()) {
      throw new Error('Link service returned an invalid tenant');
    }
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    chmodSync(configDir, 0o700);
    const temporary = `${destination}.tmp.${process.pid}`;
    writeFileSync(temporary, JSON.stringify({
      tenant_id: result.body.tenant_id, secret, endpoint,
      link_method: 'portal-device',
      expires_at: result.body.expires_at,
    }), { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    try {
      if (replace) renameSync(temporary, destination);
      else { linkSync(temporary, destination); unlinkSync(temporary); }
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* already removed */ }
      if (error?.code === 'EEXIST') throw new Error('Another link already saved a credential. Use --replace only if you intend to switch.');
      throw error;
    }
    process.stdout.write('Client linked. Restart OpenClaw to use the Hosted account.\n');
    return;
  }
  throw new Error('Link code expired. Run the command again.');
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
