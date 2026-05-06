#!/usr/bin/env node
/**
 * AxonFlow OpenClaw plugin status CLI.
 *
 * Surfaces the values a user needs in order to:
 *   - paste their `tenant_id` into the Stripe checkout custom field when
 *     buying AxonFlow Pro (W4 paid Pro v1 launch flow);
 *   - confirm which AxonFlow endpoint the plugin would talk to;
 *   - confirm whether a Pro license token is currently wired through
 *     this process (env or pluginConfig).
 *
 * Usage:
 *
 *     axonflow-openclaw-status            # human-readable text on stdout
 *     axonflow-openclaw-status --json     # machine-readable JSON on stdout
 *     axonflow-openclaw-status --help     # this message
 *
 * Environment variables (mirror the plugin runtime resolution order):
 *
 *     AXONFLOW_LICENSE_TOKEN  — Pro plugin-claim token. When present,
 *                               status reports tier=Pro and shows a
 *                               redacted preview (last 4 chars only —
 *                               full token is NEVER printed; see
 *                               codex-plugin#41).
 *     AXONFLOW_ENDPOINT       — agent endpoint to report. Defaults to
 *                               https://try.getaxonflow.com.
 *     AXONFLOW_UPGRADE_URL    — override for the upgrade URL surfaced
 *                               to free-tier users. Defaults to
 *                               https://getaxonflow.com/pricing/.
 *     AXONFLOW_CONFIG_DIR     — where try-registration.json is read
 *                               from. Defaults to per-OS convention
 *                               (see src/cache-dir.ts).
 *
 * Exit codes:
 *     0 — status printed (regardless of registered/unregistered)
 *     1 — usage error (unknown flag)
 */

import {
  buildStatusReport,
  formatStatusReport,
  resolveStatusInputs,
} from "../dist/status.js";

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  axonflow-openclaw-status           Print status (tenant_id, endpoint, tier).\n" +
      "  axonflow-openclaw-status --json    Print status as JSON.\n" +
      "  axonflow-openclaw-status --help    Show this message.\n",
  );
}

function main() {
  const argv = process.argv.slice(2);
  let asJson = false;

  for (const a of argv) {
    if (a === "--json") {
      asJson = true;
    } else if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      usage();
      process.exit(1);
    }
  }

  // Resolve from env only — the CLI has no pluginConfig context. Users
  // running inside OpenClaw with pluginConfig.licenseToken set should
  // mirror it via AXONFLOW_LICENSE_TOKEN if they want this CLI to see
  // it. The CLI cannot read OpenClaw's runtime config from outside.
  const inputs = resolveStatusInputs(undefined);
  const report = buildStatusReport(inputs);

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatStatusReport(report));
  }
  process.exit(0);
}

main();
