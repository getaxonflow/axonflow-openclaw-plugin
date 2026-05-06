#!/usr/bin/env bash
# Runtime E2E test for the status-CLI upgrade URL surface.
#
# This PR rewrites STATUS_DEFAULT_UPGRADE_URL from the broken
# https://getaxonflow.com/pro (404) to https://getaxonflow.com/pricing/
# (200). HARD RULE #0 (runtime proof is definition of done) requires we
# exercise the change against the actual CLI surface rather than rely on
# unit tests alone.
#
# What this test asserts by invoking the built plugin's status CLI:
#   1. `npx --offline @axonflow/openclaw axonflow-openclaw-status` exits 0
#      (the bin command is wired into package.json "bin" and dispatches).
#   2. Output contains the new pricing URL (`https://getaxonflow.com/pricing/`).
#   3. Output does NOT contain the old broken URL (`getaxonflow.com/pro`).
#   4. JSON mode (`--json`) emits a structured report with the same
#      upgrade_url field.
#
# Pure-CLI test — no docker stack, no agent, no network. The status
# surface is read-only stdlib-only per src/status.ts header comment;
# this test exercises the same path a free-tier user runs.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVIDENCE_DIR="${EVIDENCE_DIR:-$REPO_ROOT/runtime-e2e/status-cli-url/EVIDENCE/$(date -u +%Y-%m-%dT%H%M%SZ)}"
mkdir -p "$EVIDENCE_DIR"

cd "$REPO_ROOT"

echo "=== runtime-e2e: status-CLI upgrade URL surface ==="
echo "Repo root: $REPO_ROOT"
echo "Evidence dir: $EVIDENCE_DIR"
echo ""

# -----------------------------------------------------------------------------
# Step 1: run the bin in human-readable mode
# -----------------------------------------------------------------------------
echo "Step 1: bin/axonflow-openclaw-status.mjs (human-readable)"
human_out="$EVIDENCE_DIR/status_human.txt"
human_err="$EVIDENCE_DIR/status_human.err"

# Run with isolated config dir so we don't read the developer's real
# ~/.config/axonflow registration file.
TMP_CONFIG_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_CONFIG_DIR"' EXIT

if AXONFLOW_CONFIG_DIR="$TMP_CONFIG_DIR" \
   node "$REPO_ROOT/bin/axonflow-openclaw-status.mjs" \
       > "$human_out" 2>"$human_err"; then
    echo "  OK: bin exit 0"
else
    echo "  FAIL: bin exit non-zero"
    echo "  stderr:"
    cat "$human_err"
    exit 1
fi

# -----------------------------------------------------------------------------
# Step 2: assert new URL is present, old URL absent
# -----------------------------------------------------------------------------
echo ""
echo "Step 2: assert new pricing URL is in human-readable output"
if grep -qF "https://getaxonflow.com/pricing/" "$human_out"; then
    echo "  OK: contains https://getaxonflow.com/pricing/"
else
    echo "  FAIL: pricing URL missing from output"
    cat "$human_out"
    exit 1
fi

if grep -qF "getaxonflow.com/pro " "$human_out" \
   || grep -qE "getaxonflow\.com/pro$" "$human_out"; then
    echo "  FAIL: stale /pro URL present in output"
    cat "$human_out"
    exit 1
fi
echo "  OK: stale /pro URL absent from output"

# -----------------------------------------------------------------------------
# Step 3: run --json and parse via jq
# -----------------------------------------------------------------------------
echo ""
echo "Step 3: bin --json mode"
json_out="$EVIDENCE_DIR/status_json.json"

AXONFLOW_CONFIG_DIR="$TMP_CONFIG_DIR" \
node "$REPO_ROOT/bin/axonflow-openclaw-status.mjs" --json > "$json_out"

if ! jq . "$json_out" > /dev/null 2>&1; then
    echo "  FAIL: --json output is not valid JSON"
    cat "$json_out"
    exit 1
fi
echo "  OK: --json output parses"

upgrade_url=$(jq -r '.upgrade_url' "$json_out")
if [ "$upgrade_url" = "https://getaxonflow.com/pricing/" ]; then
    echo "  OK: .upgrade_url == https://getaxonflow.com/pricing/"
else
    echo "  FAIL: .upgrade_url == \"$upgrade_url\" (expected https://getaxonflow.com/pricing/)"
    exit 1
fi

echo ""
echo "=== PASS — status CLI surfaces the canonical pricing URL ==="
echo "  Evidence: $EVIDENCE_DIR/"
