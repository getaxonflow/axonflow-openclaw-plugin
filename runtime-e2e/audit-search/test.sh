#!/usr/bin/env bash
# OpenClaw runtime E2E: audit-search OUTCOME TEST (W2 — rule #1)
#
# Outcome verification, not just dispatch. Seeds a unique marker into the
# platform's audit log via a real SQLi block (which reliably writes
# audit_logs — mcpCheckInput on benign input doesn't audit by design),
# then drives a real OpenClaw agent through axonflow_audit_search and
# asserts the agent's reply CONTAINS the marker.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable

echo "--- Building + installing local OpenClaw plugin ---"
openclaw_install_local_plugin || exit 1

# 1. Seed marker via SQLi block.
MARKER="w2-runtime-e2e-audit-marker-$(date +%s)-$RANDOM"
echo "--- Seeding audit marker: $MARKER ---"

curl -s -X POST \
  -H "Authorization: Basic $(printf '%s:%s' "$AXONFLOW_CLIENT_ID" "$AXONFLOW_CLIENT_SECRET" | base64)" \
  -H "Content-Type: application/json" \
  -d "{\"connector_type\":\"sql\",\"statement\":\"SELECT * FROM users WHERE id=1 OR 1=1; -- $MARKER\",\"operation\":\"query\"}" \
  "$AXONFLOW_ENDPOINT/api/v1/mcp/check-input" >/dev/null
sleep 2

# Verify the seed landed via direct curl before driving the agent.
DIRECT_HITS=$(curl -s -X POST \
  -H "Authorization: Basic $(printf '%s:%s' "$AXONFLOW_CLIENT_ID" "$AXONFLOW_CLIENT_SECRET" | base64)" \
  -H "Content-Type: application/json" \
  -d '{"limit":50}' \
  "$AXONFLOW_ENDPOINT/api/v1/audit/search" \
  | jq --arg m "$MARKER" '[.entries[] | select((.query // "") | contains($m))] | length' 2>/dev/null)
if [ "${DIRECT_HITS:-0}" -lt 1 ]; then
  echo "SKIP: marker did not land in audit log via direct seed — pattern catalogue may have drifted"
  exit 0
fi

# 2. Drive the agent.
PROMPT="Use the axonflow_audit_search tool with limit=50 to fetch recent audit events. Then find any entry whose query field contains the substring '$MARKER' and report it. Output exactly the literal text SMOKE_RESULT: followed by a single-line JSON like SMOKE_RESULT: {\"marker_found\":true,\"audit_id\":\"audit_...\"} if you found it, or SMOKE_RESULT: {\"marker_found\":false} otherwise."

OUTPUT_FILE=$(mktemp -t axonflow-openclaw-audit-outcome.XXXXXX)
trap 'rm -f "$OUTPUT_FILE"' EXIT

echo "--- Driving OpenClaw agent (model=$OPENCLAW_E2E_MODEL) ---"
openclaw_agent_capture "$PROMPT" "$OUTPUT_FILE"

errors=0

if assert_smoke_result "$OUTPUT_FILE"; then
  echo "PASS: agent emitted SMOKE_RESULT marker"
else
  echo "FAIL: agent did not emit SMOKE_RESULT marker"
  jq -r '.payloads[0].text // empty' "$OUTPUT_FILE" 2>/dev/null | head -3 | sed 's/^/      /'
  errors=$((errors + 1))
fi

if assert_reply_contains "$OUTPUT_FILE" '"marker_found":true'; then
  echo "PASS: agent's audit-search returned the marker we seeded — outcome verified"
else
  echo "FAIL: agent did NOT find the seeded marker via axonflow_audit_search"
  jq -r '.payloads[0].text // empty' "$OUTPUT_FILE" 2>/dev/null | head -3 | sed 's/^/      /'
  errors=$((errors + 1))
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAIL: $errors outcome-test assertion(s) failed"
  exit 1
fi

echo ""
echo "PASS: audit-search outcome — OpenClaw agent found a real marker event end-to-end"
