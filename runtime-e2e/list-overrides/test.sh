#!/usr/bin/env bash
# OpenClaw runtime E2E: list-overrides OUTCOME TEST (W2 — rule #1)
#
# The override read stays on AxonFlow v11.0.0; the writes are retired, so no
# override can be seeded for it to find. The suite asserts the retirement (the
# write answers 409 LEGACY_POLICY_WRITE_FROZEN, never a skip), then drives a
# real OpenClaw agent through axonflow_list_overrides and asserts the runtime
# dispatched it and the count the agent reports is the count the platform
# reports.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable

echo "--- Building + installing local OpenClaw plugin ---"
openclaw_install_local_plugin || exit 1

AXONFLOW_AUTH_HDR="Authorization: Basic $(printf '%s:%s' "$AXONFLOW_CLIENT_ID" "$AXONFLOW_CLIENT_SECRET" | base64)"
errors=0

echo "--- Pre-flight: the override write is retired, so there is nothing to seed ---"
RESPONSE=$(curl -s -X POST \
  -H "$AXONFLOW_AUTH_HDR" \
  -H "Content-Type: application/json" \
  -H "X-User-Email: dev@getaxonflow.com" \
  -d '{"policy_id":"sys_pii_email","policy_type":"static","override_reason":"list-runtime-e2e","ttl_seconds":300}' \
  -w "\nHTTP_STATUS:%{http_code}" \
  "$AXONFLOW_ENDPOINT/api/v1/overrides")
STATUS=$(printf '%s' "$RESPONSE" | sed -n 's/^HTTP_STATUS://p')
BODY=$(printf '%s' "$RESPONSE" | sed '$d')
require_override_write_frozen "$STATUS" "$BODY" || exit 1
echo "PASS: the write answered 409 LEGACY_POLICY_WRITE_FROZEN"

REST_COUNT=$(curl -s -X GET -H "$AXONFLOW_AUTH_HDR" "$AXONFLOW_ENDPOINT/api/v1/overrides" | jq -r '.count // empty')
if [ -z "$REST_COUNT" ]; then
  echo "FAIL: GET /api/v1/overrides returned no count"
  exit 1
fi
echo "--- The platform reports $REST_COUNT override(s) ---"

OUTPUT_FILE=$(mktemp -t axonflow-openclaw-listov.XXXXXX)
trap 'rm -f "$OUTPUT_FILE" "$OUTPUT_FILE.stderr"' EXIT

PROMPT='Use the axonflow_list_overrides tool with no arguments. Output exactly the literal text SMOKE_RESULT: followed by single-line JSON like SMOKE_RESULT: {"count":<the count field of the tool result>}.'

echo "--- Driving OpenClaw agent (model=$OPENCLAW_E2E_MODEL) ---"
openclaw_agent_capture "$PROMPT" "$OUTPUT_FILE"

if assert_tool_dispatched "$OUTPUT_FILE" "axonflow_list_overrides"; then
  echo "PASS: the runtime dispatched axonflow_list_overrides"
else
  echo "FAIL: axonflow_list_overrides never appears in the turn's tool summary"
  errors=$((errors + 1))
fi

if assert_smoke_result "$OUTPUT_FILE"; then
  echo "PASS: agent emitted SMOKE_RESULT marker"
else
  echo "FAIL: agent did not emit SMOKE_RESULT marker"
  jq -r '.payloads[0].text // empty' "$OUTPUT_FILE" 2>/dev/null | head -3 | sed 's/^/      /'
  errors=$((errors + 1))
fi

AGENT_COUNT=$(extract_smoke_line "$OUTPUT_FILE" | jq -r '.count // empty' 2>/dev/null)
if [ -n "$AGENT_COUNT" ] && [ "$AGENT_COUNT" = "$REST_COUNT" ]; then
  echo "PASS: the count the agent read ($AGENT_COUNT) is the count the platform reports"
else
  echo "FAIL: the agent reported count ${AGENT_COUNT:-<none>}, the platform reports $REST_COUNT"
  errors=$((errors + 1))
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAIL: $errors outcome-test assertion(s) failed"
  exit 1
fi
echo ""
echo "PASS: list-overrides outcome — the write is retired and the OpenClaw agent read the platform's override list"
