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
 *     4. Telemetry heartbeat fires once (counter goes 0 → 1) with the v1
 *        schema fields populated: telemetry_type=plugin,
 *        deployment_mode=community_saas (the resolved config.endpoint in
 *        community-saas mode is `https://try.getaxonflow.com`, which
 *        matches the `*.try.getaxonflow.com` rule directly — the
 *        AXONFLOW_HARNESS_AGENT_ENDPOINT override only redirects the
 *        bootstrap probe, not the user-facing endpoint), endpoint_type=remote
 *        (try.getaxonflow.com is a remote host).
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
  // PYTHONUNBUFFERED=1 forces line-buffered stdout. The file-based readiness
  // sentinel is the authoritative signal anyway, but unbuffered stdout
  // also helps surface server errors faster if the sentinel never lands.
  const proc = spawn("python3", [serverScript, String(port), workDir], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  // Capture stdout for diagnostics in case the sentinel never appears.
  let serverStdout = "";
  proc.stdout.on("data", (chunk) => { serverStdout += chunk.toString(); });

  const readyFile = path.join(workDir, "_server_ready");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyFile)) return proc;
    if (proc.exitCode !== null) {
      throw new Error(`server exited early code=${proc.exitCode}\n${serverStdout}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`server didn't start within 30s\n--- server stdout ---\n${serverStdout}`);
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
  // Community-SaaS mode resolves config.endpoint to `https://try.getaxonflow.com`
  // (the public user-facing URL); only the bootstrap probe is redirected to
  // 127.0.0.1 via AXONFLOW_HARNESS_AGENT_ENDPOINT. The v1 deployment-mode
  // classifier therefore reports `community_saas` directly from the host
  // match — no need for the explicit AXONFLOW_TRY=1 override here.
  delete process.env.AXONFLOW_TRY;
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
    // v1 telemetry-schema (#2008) — assert the four payload contracts the
    // plugin promises to the checkpoint receiver.
    if (pings.length > 0 && pings[0].telemetry_type === "plugin") {
      pass("ping telemetry_type=plugin");
    } else {
      fail(`ping telemetry_type mismatch: ${pings[0]?.telemetry_type}`);
    }
    if (pings.length > 0 && pings[0].deployment_mode === "community_saas") {
      pass("ping deployment_mode=community_saas (try.getaxonflow.com host)");
    } else {
      fail(`ping deployment_mode mismatch: ${pings[0]?.deployment_mode}`);
    }
    if (pings.length > 0 && pings[0].endpoint_type === "remote") {
      pass("ping endpoint_type=remote (try.getaxonflow.com is a remote host)");
    } else {
      fail(`ping endpoint_type mismatch: ${pings[0]?.endpoint_type}`);
    }
    // `profile` field intentionally absent from v1 — collided with the
    // governance `AXONFLOW_PROFILE` env var (platform/agent/profile.go) and
    // was dropped before any tag shipped (#2033).
    if (pings.length > 0 && !("profile" in pings[0])) {
      pass("ping has no profile field (dropped per #2033)");
    } else {
      fail(`ping unexpectedly carries profile field: ${pings[0]?.profile}`);
    }
    if (pings.length > 0 && pings[0].sdk === "openclaw-plugin") {
      pass("ping sdk=openclaw-plugin");
    } else {
      fail(`ping sdk mismatch: ${pings[0]?.sdk}`);
    }
    // #3619: license_tier is the licence tier the PLATFORM reports about
    // itself, read from the `tier` key of the /health response the heartbeat
    // already fetches. The fake answers "Professional" - deliberately not a
    // value any client-side default would produce - so this cannot pass by
    // coincidence. Relayed verbatim: the receiver owns the canonical mapping.
    if (pings.length > 0 && pings[0].license_tier === "Professional") {
      pass("ping license_tier=Professional (relayed verbatim from /health tier)");
    } else {
      fail(
        `ping license_tier=${"license_tier" in (pings[0] ?? {}) ? pings[0].license_tier : "__ABSENT__"} (expected Professional from the /health tier key)`,
      );
    }
    // license_tier must not be conflated with deployment_mode: this run reports
    // a Professional-licensed platform reached over a remote community_saas
    // host. Two different dimensions, two different values.
    if (pings.length > 0 && pings[0].license_tier !== pings[0].deployment_mode) {
      pass(
        `license_tier (${pings[0].license_tier}) and deployment_mode (${pings[0].deployment_mode}) are independent dimensions`,
      );
    } else {
      fail("license_tier and deployment_mode read the same value - the two dimensions are being conflated");
    }


    // #3672: edition and platform_deployment_mode ride the SAME /health
    // response, relayed verbatim and omitted when not learned.
    if (pings.length > 0 && pings[0].edition === "enterprise") {
      pass("ping edition=enterprise (relayed verbatim from /health edition)");
    } else {
      fail(
        `ping edition=${"edition" in (pings[0] ?? {}) ? pings[0].edition : "__ABSENT__"} (expected enterprise)`,
      );
    }

    // THE assertion that makes the relay meaningful. The fake platform reports
    // "kubernetes" about ITSELF while this plugin classifies the endpoint it
    // was pointed at as community_saas. A relay that wrote one over the other
    // would corrupt every existing deployment-mode figure, and only a fixture
    // where the two DISAGREE can catch it.
    if (pings.length > 0 && pings[0].platform_deployment_mode === "kubernetes") {
      pass("ping platform_deployment_mode=kubernetes (the platform's own mode)");
    } else {
      fail(
        `ping platform_deployment_mode=${
          "platform_deployment_mode" in (pings[0] ?? {})
            ? pings[0].platform_deployment_mode
            : "__ABSENT__"
        } (expected kubernetes)`,
      );
    }
    if (
      pings.length > 0 &&
      pings[0].deployment_mode === "community_saas" &&
      pings[0].platform_deployment_mode !== pings[0].deployment_mode
    ) {
      pass(
        `deployment_mode (${pings[0].deployment_mode}, this plugin's own classification) survived the relay of platform_deployment_mode (${pings[0].platform_deployment_mode})`,
      );
    } else {
      fail("the platform's deployment mode was written over this plugin's own classification");
    }    // v9.1 (#2277): plugin telemetry includes org_id, sourced from the
    // registration file's tenant_id (or sentinel). With a fresh cs_<uuid>
    // registration above, org_id MUST match the cs_<uuid> tenant_id.
    if (pings.length > 0) {
      const expectedOrgId = JSON.parse(fs.readFileSync(regFile, "utf8")).tenant_id;
      if (pings[0].org_id === expectedOrgId) {
        pass(`ping org_id matches registered tenant_id (${pings[0].org_id})`);
      } else if (pings[0].org_id === "local-dev-org") {
        fail(
          `ping org_id is sentinel local-dev-org; expected cs_<uuid> from registration (${expectedOrgId})`,
        );
      } else {
        fail(
          `ping org_id=${pings[0].org_id} (expected ${expectedOrgId} from registration file)`,
        );
      }
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
