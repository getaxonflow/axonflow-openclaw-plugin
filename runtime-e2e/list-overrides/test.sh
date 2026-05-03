#!/usr/bin/env bash
# OpenClaw runtime E2E: list-overrides (W2 — rule #1)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable
openclaw_install_local_plugin || exit 1

PROMPT='Use the axonflow_list_overrides tool with no arguments to list active overrides for the tenant. After receiving the tool result, output exactly "SMOKE_RESULT: " followed by a one-line JSON summary like SMOKE_RESULT: {"count":N}.'

OUTPUT_FILE=$(mktemp -t axonflow-openclaw-listov.XXXXXX)
trap 'rm -f "$OUTPUT_FILE"' EXIT

echo "--- Running openclaw agent (axonflow_list_overrides) ---"
openclaw_agent_capture "$PROMPT" "$OUTPUT_FILE"

errors=0

if assert_tool_in_summary "$OUTPUT_FILE" "axonflow_list_overrides"; then
  echo "PASS: agent invoked axonflow_list_overrides through OpenClaw's tool dispatcher"
else
  echo "FAIL: agent did not invoke axonflow_list_overrides"
  errors=$((errors + 1))
fi

if assert_smoke_result "$OUTPUT_FILE"; then
  echo "PASS: agent emitted SMOKE_RESULT marker"
else
  echo "FAIL: agent did not emit SMOKE_RESULT marker"
  errors=$((errors + 1))
fi

if assert_reply_contains "$OUTPUT_FILE" '"count"'; then
  echo "PASS: response carries count field"
else
  echo "FAIL: response missing count field"
  errors=$((errors + 1))
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAIL: $errors runtime-path assertion(s) failed"
  jq -r '.payloads[0].text // empty' "$OUTPUT_FILE" 2>/dev/null | head -5 | sed 's/^/      /'
  exit 1
fi
echo ""
echo "PASS: list-overrides — OpenClaw agent dispatched axonflow_list_overrides end-to-end"
