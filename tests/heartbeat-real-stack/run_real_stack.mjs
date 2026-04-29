/**
 * Real-stack E2E harness for the OpenClaw plugin Community-SaaS-default
 * rollout (ADR-048).
 *
 * Drives the plugin through its actual public registration entry point
 * (registerAxonFlowGovernance) twice:
 *
 *   Run 1 — COLD START. Sandboxed cache+config dirs, no registration
 *   file, no telemetry stamp. Expectations:
 *     1. registerAxonFlowGovernance returns without throwing.
 *     2. Mode-clarity canary on the captured logger:
 *        "[AxonFlow] Connected to AxonFlow at <url> (mode=community-saas)".
 *     3. Bootstrap registers against the fake /api/v1/register and
 *        persists try-registration.json (mode 0600 on POSIX).
 *     4. Telemetry heartbeat fires once (counter goes 0 → 1) with
 *        deployment_mode=community-saas.
 *     5. Telemetry stamp file written.
 *
 *   Run 2 — WARM CACHE. Same sandbox dirs. Expectations:
 *     1. Bootstrap reads cached registration (no fresh /register call).
 *     2. Telemetry heartbeat is suppressed by the 7-day stamp gate
 *        (counter delta = 0).
 *
 * Cross-platform: tested on Ubuntu, macOS, and Windows.
 * Requires: node 20+, python3 (for server.py).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.dirname(path.dirname(HARNESS_DIR));

let passed = 0;
let failed = 0;

function pass(msg) {
  console.log(`  PASS: ${msg}`);
  passed += 1;
}

function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  failed += 1;
}

async function findFreePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function startServer(port, workDir) {
  const serverScript = path.join(HARNESS_DIR, "server.py");
  const proc = spawn("python3", [serverScript, String(port), workDir], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    // 30s budget — macOS GH runners cold-start Python noticeably slower.
    const t = setTimeout(() => reject(new Error("server didn't start within 30s")), 30000);
    proc.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("server ready")) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`server exited early code=${code}`));
    });
  });
  return proc;
}

function readCounter(workDir) {
  try {
    return parseInt(fs.readFileSync(path.join(workDir, "_counter"), "utf8").trim() || "0", 10);
  } catch {
    return 0;
  }
}

function readPings(workDir) {
  try {
    const raw = fs.readFileSync(path.join(workDir, "_pings.jsonl"), "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function readRegistrations(workDir) {
  try {
    const raw = fs.readFileSync(path.join(workDir, "_registrations.jsonl"), "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function captureLogger() {
  const calls = { info: [], warn: [], error: [] };
  return {
    logger: {
      info: (m) => calls.info.push(String(m)),
      warn: (m) => calls.warn.push(String(m)),
      error: (m) => calls.error.push(String(m)),
    },
    calls,
  };
}

async function loadPluginAndRegister({ endpoint, configDir, cacheDir, checkpointUrl }) {
  process.env.AXONFLOW_CACHE_DIR = cacheDir;
  process.env.AXONFLOW_CONFIG_DIR = configDir;
  process.env.AXONFLOW_CHECKPOINT_URL = checkpointUrl;
  // Test-harness override hooks — only the bootstrap and telemetry honour
  // these (production code paths leave AXONFLOW_HARNESS unset).
  process.env.AXONFLOW_HARNESS = "1";
  process.env.AXONFLOW_HARNESS_REGISTER_URL = `${endpoint}/api/v1/register`;
  process.env.AXONFLOW_HARNESS_AGENT_ENDPOINT = endpoint;
  delete process.env.AXONFLOW_TELEMETRY;

  // Wipe Node module cache so a second cold-start re-runs init.
  const distEntry = path.join(PLUGIN_DIR, "dist", "index.js");
  if (!fs.existsSync(distEntry)) {
    throw new Error(`dist/index.js not found at ${distEntry} — run 'npm run build' first`);
  }
  // Use a cache-busting query string so each run gets a fresh module instance.
  const cacheBust = `?t=${Date.now()}-${Math.random()}`;
  const moduleUrl = pathToFileURL(distEntry).href + cacheBust;
  const mod = await import(moduleUrl);
  const { registerAxonFlowGovernance, _resetTelemetryInFlightForTests, _resetBootstrapInFlightForTests } =
    mod.default && typeof mod.default === "object"
      ? { ...mod, ...mod.default }
      : mod;

  if (typeof _resetBootstrapInFlightForTests === "function") _resetBootstrapInFlightForTests();
  if (typeof _resetTelemetryInFlightForTests === "function") _resetTelemetryInFlightForTests();

  const { logger, calls } = captureLogger();
  const hooks = [];
  registerAxonFlowGovernance({
    pluginConfig: {},
    logger,
    on: (event, handler, opts) => hooks.push({ event, handler, opts }),
  });

  // The plugin fires bootstrap and telemetry as fire-and-forget promises.
  // Wait long enough for them to settle.
  await new Promise((r) => setTimeout(r, 1500));

  return { calls, hooks };
}

async function main() {
  const port = await findFreePort();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "axonflow-realstack-work-"));
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "axonflow-realstack-home-"));
  const cacheDir = path.join(sandbox, "cache");
  const configDir = path.join(sandbox, "config");
  const endpoint = `http://127.0.0.1:${port}`;
  const checkpointUrl = `${endpoint}/v1/ping`;

  let serverProc;
  try {
    serverProc = await startServer(port, workDir);

    // -----------------------------------------------------------------------
    // Run 1: COLD START
    // -----------------------------------------------------------------------
    console.log("--- Cold start: bootstrap + first heartbeat ---");

    const cold = await loadPluginAndRegister({ endpoint, configDir, cacheDir, checkpointUrl });

    // Mode-clarity canary on the logger. Per ADR-048 the canary is emitted
    // at config-resolve time, BEFORE the async bootstrap fires — so in
    // community-saas mode it reports the user-facing
    // `https://try.getaxonflow.com`, not the bootstrapped agent endpoint.
    // We assert that exact contract here (matches what production users see).
    const canary = cold.calls.info.find((m) => m.startsWith("[AxonFlow] Connected to AxonFlow at "));
    if (canary === "[AxonFlow] Connected to AxonFlow at https://try.getaxonflow.com (mode=community-saas)") {
      pass("mode-clarity canary reports try.getaxonflow.com + community-saas");
    } else {
      fail(`canary missing or mismatched: ${JSON.stringify(canary)}`);
    }
    // Verify the post-bootstrap registration-complete log fires too so we
    // know the bootstrap landed before the harness assertions ran.
    const bootstrapDone = cold.calls.info.find((m) => m.includes("Community SaaS registration"));
    if (bootstrapDone) {
      pass("bootstrap completion log fired");
    } else {
      fail(`bootstrap completion log missing — async bootstrap may not have settled`);
    }

    // Registration file present at expected path with mode 0600 on POSIX.
    const regFile = path.join(configDir, "try-registration.json");
    if (fs.existsSync(regFile)) {
      pass("registration file written");
      if (process.platform !== "win32") {
        const mode = fs.statSync(regFile).mode & 0o777;
        if (mode === 0o600) pass(`registration file mode is 0600`);
        else fail(`registration file mode is 0${mode.toString(8)} (expected 0600)`);
      }
      const reg = JSON.parse(fs.readFileSync(regFile, "utf8"));
      if (reg.tenant_id && reg.tenant_id.startsWith("cs_")) {
        pass(`registration tenant_id is cs_<uuid> (${reg.tenant_id})`);
      } else {
        fail(`registration tenant_id not cs_*: ${reg.tenant_id}`);
      }
    } else {
      fail(`registration file not written at ${regFile}`);
    }

    const coldCounter = readCounter(workDir);
    if (coldCounter === 1) {
      pass("telemetry heartbeat fired exactly once (counter=1)");
    } else {
      fail(`telemetry counter is ${coldCounter} (expected 1)`);
    }

    const pings = readPings(workDir);
    if (pings.length > 0 && pings[0].deployment_mode === "community-saas") {
      pass("ping deployment_mode=community-saas");
    } else {
      fail(`ping deployment_mode mismatch: ${pings[0]?.deployment_mode}`);
    }
    if (pings.length > 0 && pings[0].sdk === "openclaw-plugin") {
      pass("ping sdk=openclaw-plugin");
    } else {
      fail(`ping sdk mismatch: ${pings[0]?.sdk}`);
    }

    const stampFile = path.join(cacheDir, "openclaw-plugin-telemetry-sent");
    if (fs.existsSync(stampFile)) {
      pass("telemetry stamp file written");
      if (process.platform !== "win32") {
        const m = fs.statSync(stampFile).mode & 0o777;
        if (m === 0o600) pass("telemetry stamp file mode is 0600");
        else fail(`telemetry stamp file mode is 0${m.toString(8)} (expected 0600)`);
      }
    } else {
      fail(`telemetry stamp file not written at ${stampFile}`);
    }

    const regsBefore = readRegistrations(workDir).length;

    // -----------------------------------------------------------------------
    // Run 2: WARM CACHE
    // -----------------------------------------------------------------------
    console.log("");
    console.log("--- Warm cache: stamp gate + cached registration ---");
    const counterBefore = readCounter(workDir);
    await loadPluginAndRegister({ endpoint, configDir, cacheDir, checkpointUrl });

    const regsAfter = readRegistrations(workDir).length;
    if (regsAfter === regsBefore) {
      pass("no new registration POST (cached path)");
    } else {
      fail(`warm-cache fired ${regsAfter - regsBefore} extra registration(s)`);
    }

    const counterAfter = readCounter(workDir);
    if (counterAfter === counterBefore) {
      pass("telemetry suppressed by stamp gate (delta=0)");
    } else {
      fail(`telemetry counter went ${counterBefore} → ${counterAfter} (expected delta 0)`);
    }
  } finally {
    if (serverProc) serverProc.kill();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  console.log("");
  console.log("========================================");
  console.log(" Real-stack E2E summary");
  console.log("========================================");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
