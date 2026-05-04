#!/usr/bin/env bash
# OpenClaw runtime E2E: create_override REJECTION OUTCOME (W2 — rule #1)
#
# Verifies that the platform's allow_override=FALSE enforcement is reachable
# through the OpenClaw runtime path. Pre-platform-fix the create_override
# call on sys_sqli_admin_bypass would silently succeed; post-fix the
# platform returns 403 and the agent surfaces the rejection.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable

echo "--- Building + installing local OpenClaw plugin ---"
openclaw_install_local_plugin || exit 1

PROMPT='Use the axonflow_create_override tool with policy_id="sys_sqli_admin_bypass", policy_type="static", and override_reason="runtime-e2e rejection verification". The platform should reject because the policy is severity=critical. After the tool call, output exactly the literal text SMOKE_RESULT: followed by a single-line JSON like SMOKE_RESULT: {"dispatched":true,"server_rejected":true,"http_status":403} or SMOKE_RESULT: {"dispatched":true,"server_rejected":false} if the platform unexpectedly accepted.'

OUTPUT_FILE=$(mktemp -t axonflow-openclaw-create.XXXXXX)
trap 'rm -f "$OUTPUT_FILE"' EXIT

echo "--- Driving OpenClaw agent (model=$OPENCLAW_E2E_MODEL) ---"
openclaw_agent_capture "$PROMPT" "$OUTPUT_FILE"

errors=0

if assert_smoke_result "$OUTPUT_FILE"; then
  echo "PASS: agent emitted SMOKE_RESULT marker"
else
  echo "FAIL: agent did not emit SMOKE_RESULT marker"
  errors=$((errors + 1))
fi

# Agent reply should reflect the platform rejection. Different models phrase
# 4xx differently; assert at least one of the canonical strings.
if assert_reply_contains "$OUTPUT_FILE" '"server_rejected":true' \
  || assert_reply_contains "$OUTPUT_FILE" 'Critical-risk policies cannot be overridden' \
  || assert_reply_contains "$OUTPUT_FILE" 'allow_override' \
  || assert_reply_contains "$OUTPUT_FILE" '403'; then
  echo "PASS: agent surfaced the platform rejection — outcome verified"
else
  jq -r '.payloads[0].text // empty' "$OUTPUT_FILE" 2>/dev/null | head -3 | sed 's/^/      /'
  echo "FAIL: agent did NOT surface the rejection"
  errors=$((errors + 1))
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAIL: $errors outcome-test assertion(s) failed"
  exit 1
fi
echo ""
echo "PASS: create-override — agent dispatched + platform rejected + agent surfaced rejection (end-to-end outcome)"
