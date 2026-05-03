#!/usr/bin/env bash
# OpenClaw runtime E2E: revoke-override (W2 — rule #1)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable
openclaw_install_local_plugin || exit 1

PROMPT='Use the axonflow_revoke_override tool with override_id="runtime-e2e-fabricated-override-id-12345". The platform will return a not-found result. After receiving the tool result, output exactly "SMOKE_RESULT: " followed by a one-line JSON summary like SMOKE_RESULT: {"dispatched":true,"not_found":true}.'

OUTPUT_FILE=$(mktemp -t axonflow-openclaw-revoke.XXXXXX)
trap 'rm -f "$OUTPUT_FILE"' EXIT

echo "--- Running openclaw agent (axonflow_revoke_override, fabricated id) ---"
openclaw_agent_capture "$PROMPT" "$OUTPUT_FILE"

errors=0

if assert_tool_in_summary "$OUTPUT_FILE" "axonflow_revoke_override"; then
  echo "PASS: agent invoked axonflow_revoke_override through OpenClaw's tool dispatcher"
else
  echo "FAIL: agent did not invoke axonflow_revoke_override"
  errors=$((errors + 1))
fi

if assert_smoke_result "$OUTPUT_FILE"; then
  echo "PASS: agent emitted SMOKE_RESULT marker"
else
  echo "FAIL: agent did not emit SMOKE_RESULT marker"
  errors=$((errors + 1))
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAIL: $errors runtime-path assertion(s) failed"
  jq -r '.payloads[0].text // empty' "$OUTPUT_FILE" 2>/dev/null | head -5 | sed 's/^/      /'
  exit 1
fi
echo ""
echo "PASS: revoke-override — OpenClaw agent dispatched axonflow_revoke_override end-to-end"
