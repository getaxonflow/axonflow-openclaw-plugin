#!/usr/bin/env node
/**
 * Pre-publish security-scan gate.
 *
 * Packs the plugin with `npm pack`, extracts the tarball, and runs the
 * official OpenClaw plugin scanner against the extracted tree. The
 * scanner is the same code that ClawHub runs server-side at publish
 * time — running it locally + in CI catches scanner regressions before
 * they ship instead of after.
 *
 * Two ways to invoke:
 *   - Local pre-commit: `npm run scan` (this script).
 *   - CI: `.github/workflows/security-scan.yml` runs the same script.
 *
 * Behaviour:
 *   - Builds the project first (so dist/ reflects current src/).
 *   - Packs into a tmp dir so the scanner sees exactly what ClawHub
 *     will see (npm-pack `files` whitelist applied — no scripts/, no
 *     tests/, no src/).
 *   - Isolates OpenClaw state under a tmp OPENCLAW_STATE_DIR so the
 *     scan does not pollute the developer's ~/.openclaw or override
 *     an existing axonflow-governance install.
 *   - Parses scanner stdout/stderr for WARNING + critical + blocked
 *     patterns. Any finding fails the scan with a non-zero exit.
 *
 * Exit codes:
 *   0   PASS — no scanner findings.
 *   1   FAIL — scanner reported critical/warning, or scanner exec failed.
 *   2   SETUP ERROR — could not pack, openclaw CLI missing, etc.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const SETUP_ERROR = 2;
const SCAN_FAIL = 1;
const PASS = 0;

function fatal(code, msg) {
  process.stderr.write(`scan-tarball: ${msg}\n`);
  process.exit(code);
}

function info(msg) {
  process.stdout.write(`scan-tarball: ${msg}\n`);
}

// 1. Sanity: openclaw CLI must be installed and on PATH. We rely on the
//    same scanner the real install path uses; pinning to a specific
//    openclaw version is intentionally NOT done here — CI installs
//    `openclaw@latest` to validate against the most current ruleset.
const openclawCheck = spawnSync("openclaw", ["--version"], { encoding: "utf8" });
if (openclawCheck.status !== 0) {
  fatal(
    SETUP_ERROR,
    `openclaw CLI not on PATH. Install with: npm install -g openclaw@latest`,
  );
}
info(`openclaw: ${(openclawCheck.stdout || "").trim()}`);

// 2. Build (so dist/ reflects src/). Skip when invoked with --no-build
//    to make the local fast loop quicker; CI always builds.
const skipBuild = process.argv.includes("--no-build");
if (!skipBuild) {
  info("Building plugin (npm run build)…");
  const build = spawnSync("npm", ["run", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    fatal(SETUP_ERROR, "npm run build failed");
  }
}

// 3. Pack. Output goes to a tmp dir so we don't litter the repo with
//    .tgz artifacts on every local scan.
const packDir = mkdtempSync(join(tmpdir(), "openclaw-scan-pack-"));
let tarballPath;
try {
  info(`Packing into ${packDir}…`);
  const packOut = execFileSync("npm", ["pack", "--pack-destination", packDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const tarballName = packOut.trim().split("\n").pop().trim();
  if (!tarballName || !tarballName.endsWith(".tgz")) {
    fatal(SETUP_ERROR, `npm pack returned unexpected output: ${packOut}`);
  }
  tarballPath = join(packDir, tarballName);
  if (!existsSync(tarballPath)) {
    fatal(SETUP_ERROR, `Packed tarball missing at ${tarballPath}`);
  }
  info(`Tarball: ${tarballPath}`);
} catch (err) {
  fatal(SETUP_ERROR, `npm pack failed: ${err.message}`);
}

// 4. Run the openclaw scanner against the tarball. Isolate state so the
//    scan never pollutes a real install or stomps an in-flight dev
//    session's config.
const stateDir = mkdtempSync(join(tmpdir(), "openclaw-scan-state-"));
info(`Scanner state isolated under ${stateDir}`);
const env = {
  ...process.env,
  OPENCLAW_STATE_DIR: stateDir,
  AXONFLOW_TELEMETRY: "off",
};

let scanStdout = "";
let scanStderr = "";
let scanStatus = 0;
try {
  const scan = spawnSync("openclaw", ["plugins", "install", tarballPath], {
    encoding: "utf8",
    env,
    timeout: 120_000,
  });
  scanStdout = scan.stdout || "";
  scanStderr = scan.stderr || "";
  scanStatus = scan.status ?? -1;
} finally {
  // Always clean up scratch dirs, even on failure paths.
  try { rmSync(packDir, { recursive: true, force: true }); } catch { /* fine */ }
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* fine */ }
}

const combined = `${scanStdout}\n${scanStderr}`;
process.stdout.write(scanStdout);
process.stderr.write(scanStderr);

// 5. Parse scanner output for findings. The OpenClaw scanner surfaces:
//    - "WARNING:" lines for criticals + warnings (terminology overlap;
//      the install-blocking severity is "critical" per the scanner
//      module but the human-readable line prefix is "WARNING:").
//    - "installation blocked:" line when at least one critical is hit.
//
// Any of those is a CI failure. The blocked line is redundant with the
// WARNING line but we match both so a future scanner output format
// change doesn't silently weaken the gate.
const findings = [];
for (const line of combined.split("\n")) {
  if (line.startsWith("WARNING:") && line.includes("dangerous code patterns")) {
    findings.push(line);
  } else if (line.includes("installation blocked")) {
    findings.push(line);
  }
}

if (scanStatus !== 0 && findings.length === 0) {
  // The install command exited non-zero for some reason other than a
  // scanner finding (e.g. plugin-already-installed conflict in shared
  // state, network error fetching a peer dep). Treat as setup error
  // rather than a scan-fail so we don't conflate the two.
  fatal(
    SETUP_ERROR,
    `openclaw plugins install exited ${scanStatus} with no scanner findings — see output above. Likely environmental.`,
  );
}

if (findings.length > 0) {
  process.stderr.write("\nscan-tarball: SCAN FAILED — scanner reported findings:\n");
  for (const f of findings) {
    process.stderr.write(`  ${f}\n`);
  }
  process.stderr.write("\nFix the source so the compiled dist files do not co-locate env-or-fs reads with outbound HTTP. See docs/security-scan.md for the refactor pattern.\n");
  process.exit(SCAN_FAIL);
}

info("Scan PASSED — 0 criticals, 0 warnings.");
process.exit(PASS);
