#!/usr/bin/env bash
# Runtime proof for license_tier on the heartbeat (#3619).
#
# Three stages, all driving the plugin's ACTUAL shipped code — no
# reimplementation of the payload, no reimplementation of the probe.
#
#   Stage 1a — the behaviour suite (`tests/telemetry.test.ts`, in full). Every
#   relayed value round-trips verbatim; every probe failure omits the key and
#   leaves the heartbeat intact; redirects are refused on both legs.
#
#   Stage 1b — the mutation gate. Plants a defect in src/telemetry.ts for each
#   property that suite claims to protect and requires the suite to go red, then
#   plants two behaviour-preserving controls that must SURVIVE. A green suite
#   alone would not distinguish "the field works" from "nothing is being read".
#
#   Stage 2 — the real-stack harness, which drives the public
#   registerAxonFlowGovernance entry point end to end and asserts the field
#   arrives on the wire alongside a deployment_mode it must not be conflated with.
#
# Run:
#   ./runtime-e2e/license_tier_telemetry/test.sh
#
# Exit: 0 PASS · 1 FAIL · 0 + SKIP line when required tooling is absent.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

for tool in node python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "SKIP: $tool not on PATH"
    exit 0
  fi
done

if [ ! -d "$PLUGIN_DIR/node_modules" ]; then
  echo "SKIP: node_modules absent — run 'npm ci' first"
  exit 0
fi

RC=0

echo "==> Stage 1a: telemetry behaviour suite (full)"
# The whole telemetry suite, NOT `-t "license_tier"`. That filter silently
# skipped every block whose name did not contain the phrase - including the
# relay and redirect blocks - so the stage reported green while covering none
# of them. A name-matched filter is a coverage decision disguised as a speed
# one; the suite runs in under a second.
if ( cd "$PLUGIN_DIR" && npx jest tests/telemetry.test.ts ); then
  echo "PASS: behaviour suite green"
else
  echo "FAIL: behaviour suite reported failures" >&2
  RC=1
fi

echo ""
echo "==> Stage 1b: mutation gate — the suite must be able to go red"
if ( cd "$PLUGIN_DIR" && bash tests/telemetry-license-tier-mutation-gate.sh ); then
  echo "PASS: every planted defect was caught, and both controls survived"
else
  echo "FAIL: mutation gate reported a survivor, or killed a control" >&2
  RC=1
fi

echo ""
echo "==> Stage 2: real-stack heartbeat through the public entry point"
if [ ! -f "$PLUGIN_DIR/dist/index.js" ]; then
  echo "Building plugin so dist/index.js exists..."
  ( cd "$PLUGIN_DIR" && npm run build ) || {
    echo "FAIL: npm run build failed" >&2
    exit 1
  }
fi
if ( cd "$PLUGIN_DIR" && node tests/heartbeat-real-stack/run_real_stack.mjs ); then
  echo "PASS: license_tier observed on the wire from a real registration flow"
else
  echo "FAIL: real-stack harness reported assertion failures" >&2
  RC=1
fi

exit "$RC"
