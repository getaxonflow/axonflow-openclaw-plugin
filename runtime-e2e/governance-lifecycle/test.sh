#!/usr/bin/env bash
# OpenClaw runtime E2E: governance lifecycle (rule #1 + integration)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable
openclaw_install_local_plugin || exit 1

HAVE_LICENSE=0
if [ -n "${AXONFLOW_LICENSE:-}" ]; then
  HAVE_LICENSE=1
fi
if [ "$HAVE_LICENSE" -ne 1 ]; then
  echo "INFO: AXONFLOW_LICENSE not set — running read-only lifecycle subset"
fi

PROMPT_RO='Step 1: Use the axonflow_audit_search tool with limit=3 to fetch recent audit events.

Step 2: Use the axonflow_list_overrides tool with no arguments to list active overrides.

Step 3: Output exactly "SMOKE_RESULT: " followed by a one-line JSON summary like SMOKE_RESULT: {"audit_total":N,"override_count":N}.'

OUTPUT_FILE=$(mktemp -t axonflow-openclaw-lifecycle.XXXXXX)
trap 'rm -f "$OUTPUT_FILE"' EXIT

echo "--- Running read-only lifecycle (audit_search + list_overrides chained) ---"
openclaw_agent_capture "$PROMPT_RO" "$OUTPUT_FILE"

errors=0

if assert_tool_in_summary "$OUTPUT_FILE" "axonflow_audit_search"; then
  echo "PASS: agent invoked axonflow_audit_search"
else
  echo "FAIL: agent did not invoke axonflow_audit_search in step 1"
  errors=$((errors + 1))
fi

if assert_tool_in_summary "$OUTPUT_FILE" "axonflow_list_overrides"; then
  echo "PASS: agent invoked axonflow_list_overrides"
else
  echo "FAIL: agent did not invoke axonflow_list_overrides in step 2"
  errors=$((errors + 1))
fi

if assert_smoke_result "$OUTPUT_FILE"; then
  echo "PASS: agent emitted SMOKE_RESULT marker (read-only subset complete)"
else
  echo "FAIL: agent did not complete the read-only lifecycle"
  errors=$((errors + 1))
fi

if [ "$HAVE_LICENSE" -eq 1 ]; then
  echo ""
  echo "FAIL: full lifecycle (create→list→explain→revoke→list) is not yet implemented"
  echo "      Filed as followup; needs a seeded override-able policy."
  errors=$((errors + 1))
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAIL: $errors lifecycle assertion(s) failed"
  jq -r '.payloads[0].text // empty' "$OUTPUT_FILE" 2>/dev/null | head -5 | sed 's/^/      /'
  exit 1
fi

echo ""
if [ "$HAVE_LICENSE" -eq 1 ]; then
  echo "PASS: governance-lifecycle (full)"
else
  echo "PASS: governance-lifecycle (read-only subset; mutation lifecycle SKIPPED — no license)"
fi
