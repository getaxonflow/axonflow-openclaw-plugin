#!/usr/bin/env bash
# OpenClaw runtime E2E: explain-decision OUTCOME TEST (W2 — rule #1)
#
# Triggers a real platform block to mint a real decision_id, drives the
# OpenClaw agent to explain it via axonflow_explain_decision, asserts
# the agent's reply NAMES the policy that fired (Authentication Bypass
# / sys_sqli_admin_bypass).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable

echo "--- Building + installing local OpenClaw plugin ---"
openclaw_install_local_plugin || exit 1

AXONFLOW_AUTH_HDR="Authorization: Basic $(printf '%s:%s' "$AXONFLOW_CLIENT_ID" "$AXONFLOW_CLIENT_SECRET" | base64)"

SEED_TAG="explain-runtime-e2e-$(date +%s)-$RANDOM"
echo "--- Triggering platform block to mint a decision_id ---"

CHECK_RESPONSE=$(curl -s -X POST \
  -H "$AXONFLOW_AUTH_HDR" \
  -H "Content-Type: application/json" \
  -d "{\"connector_type\":\"sql\",\"statement\":\"SELECT * FROM users WHERE id=1 OR 1=1; -- $SEED_TAG\",\"operation\":\"query\"}" \
  "$AXONFLOW_ENDPOINT/api/v1/mcp/check-input")

DECISION_ID=$(printf '%s' "$CHECK_RESPONSE" | jq -r '.decision_id // empty')
WAS_BLOCKED=$(printf '%s' "$CHECK_RESPONSE" | jq -r '.allowed')

if [ -z "$DECISION_ID" ] || [ "$WAS_BLOCKED" != "false" ]; then
  # Previously "SKIP:" + exit 0. That is the wrong outcome twice over: a
  # governance stack that does NOT block an obvious SQLi is a finding, and a
  # missing decision_id means explain_decision has nothing to explain. Skipping
  # here reported success for exactly the two conditions this suite exists to
  # detect.
  echo "FAIL: could not mint a blocked decision to explain"
  echo "      allowed=$WAS_BLOCKED decision_id='${DECISION_ID:-<none>}'"
  echo "      response: $CHECK_RESPONSE"
  echo ""
  echo "      Expected the stack to BLOCK an obvious SQLi statement and return a"
  echo "      decision_id. If allowed=true, the stack is not enforcing the"
  echo "      pattern catalogue — that is the finding, not a reason to skip."
  echo "      If allowed=false but decision_id is empty, the platform is below"
  echo "      the floor that returns one (7.1.0+)."
  exit 1
fi
echo "--- Minted decision_id: $DECISION_ID ---"
sleep 2

PROMPT="Use the axonflow_explain_decision tool with decision_id=\"$DECISION_ID\". From the tool result, extract the policy name (under policy_matches[0].policy_name or policies[0].name — whichever the response uses). Output exactly the literal text SMOKE_RESULT: followed by a single-line JSON like SMOKE_RESULT: {\"explanation_present\":true,\"policy_name\":\"...\"} or SMOKE_RESULT: {\"explanation_present\":false}."

OUTPUT_FILE=$(mktemp -t axonflow-openclaw-explain.XXXXXX)
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

if assert_reply_contains "$OUTPUT_FILE" "Authentication Bypass" \
  || assert_reply_contains "$OUTPUT_FILE" "sys_sqli_admin_bypass"; then
  echo "PASS: agent's reply names the policy that fired — outcome verified"
else
  jq -r '.payloads[0].text // empty' "$OUTPUT_FILE" 2>/dev/null | head -3 | sed 's/^/      /'
  echo "FAIL: agent did not name the policy from the explanation"
  errors=$((errors + 1))
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAIL: $errors outcome-test assertion(s) failed"
  exit 1
fi
echo ""
echo "PASS: explain-decision outcome — OpenClaw agent fetched + surfaced a real platform decision end-to-end"
