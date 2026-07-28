#!/usr/bin/env node
/**
 * AxonFlow OpenClaw plugin status CLI.
 *
 * Surfaces the values a user needs in order to:
 *   - paste their `client_id` (formerly `tenant_id`; same value, see
 *     v2.5.0 CHANGELOG) into the Stripe checkout custom field when
 *     buying AxonFlow Pro — the Stripe form's field is still labeled
 *     "AxonFlow tenant ID" until that surface rebrands separately;
 *   - confirm which AxonFlow endpoint the plugin is actually governing
 *     against, and under which deployment mode and tenant identity;
 *   - confirm whether a Pro license token is currently wired through
 *     this process (env or pluginConfig).
 *
 * This process cannot see OpenClaw's `pluginConfig`, nor the environment
 * the OpenClaw runtime was started with. To report what the runtime is
 * really doing rather than a parallel guess (#167), it reads the inputs the
 * last plugin load recorded at
 * $AXONFLOW_CONFIG_DIR/openclaw-plugin-runtime-state.json — the endpoint
 * override the runtime resolved (from either channel) and the configured
 * clientId — and feeds them to the same `resolveDeploymentTarget` helper the
 * governance runtime uses. THIS process's own AXONFLOW_ENDPOINT is still
 * applied on top and still wins, so a recorded value only ever fills a gap.
 * With no record present, resolution falls back to the environment alone.
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
 *     AXONFLOW_ENDPOINT       — agent endpoint to report. Wins over the
 *                               recorded value. When neither is set,
 *                               resolution falls back to the recorded
 *                               clientId or the Community-SaaS default.
 *     AXONFLOW_UPGRADE_URL    — override for the upgrade URL surfaced
 *                               to free-tier users. Defaults to
 *                               https://getaxonflow.com/pricing/.
 *     AXONFLOW_CONFIG_DIR     — where try-registration.json and the
 *                               plugin runtime-state record are read
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
      "  axonflow-openclaw-status           Print status (client_id, endpoint, tier).\n" +
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

  // `undefined` means "I cannot see the plugin configuration" — which
  // makes resolveStatusInputs read back the record the last plugin load
  // wrote and resolve from that plus THIS process's environment. Passing
  // `{}` would instead assert the configuration is genuinely empty.
  //
  // The license token is NOT recorded (it is a credential), so a user
  // running inside OpenClaw with pluginConfig.licenseToken set must still
  // mirror it via AXONFLOW_LICENSE_TOKEN for this CLI to report the tier.
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
