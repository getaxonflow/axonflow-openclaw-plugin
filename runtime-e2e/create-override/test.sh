#!/usr/bin/env bash
# OpenClaw runtime E2E: create-override (W2 — rule #1)
#
# Community-mode policies all have allow_override=false; the platform
# *should* reject with 403 (currently does not — known platform bug
# tracked separately). Either way, dispatch through the runtime is
# what we're testing here. The agent's reply tells us whether the
# platform accepted or rejected; that detail goes into SMOKE_RESULT.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable
openclaw_install_local_plugin || exit 1

PROMPT='Use the axonflow_create_override tool with policy_id="sys_sqli_admin_bypass", policy_type="static", and override_reason="runtime-e2e dispatch verification" (OpenClaw). After receiving the tool result, output exactly "SMOKE_RESULT: " followed by a one-line JSON summary like SMOKE_RESULT: {"dispatched":true,"created":true} or SMOKE_RESULT: {"dispatched":true,"server_rejected":true}.'

OUTPUT_FILE=$(mktemp -t axonflow-openclaw-create.XXXXXX)
trap 'rm -f "$OUTPUT_FILE"' EXIT

echo "--- Running openclaw agent (axonflow_create_override) ---"
openclaw_agent_capture "$PROMPT" "$OUTPUT_FILE"

errors=0

if assert_tool_in_summary "$OUTPUT_FILE" "axonflow_create_override"; then
  echo "PASS: agent invoked axonflow_create_override through OpenClaw's tool dispatcher"
else
  echo "FAIL: agent did not invoke axonflow_create_override"
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
echo "PASS: create-override — OpenClaw agent dispatched axonflow_create_override end-to-end"
