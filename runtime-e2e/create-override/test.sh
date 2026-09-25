#!/usr/bin/env bash
# OpenClaw runtime E2E: create_override is retired, and the plugin no longer
# offers it (#196)
#
# Session overrides are retired from AxonFlow v11.0.0: POST /api/v1/overrides
# answers 409 LEGACY_POLICY_WRITE_FROZEN, and the plugin no longer registers an
# axonflow_create_override agent tool. Both halves, on the runtime path:
#   1. the platform: POST with a per-user identity answers the 409 code, and
#      without one the identity refusal (HTTP 401) comes first;
#   2. the plugin: a real OpenClaw agent turn dispatches axonflow_get_tenant_id
#      (a registered plugin tool: the control that the turn could dispatch
#      plugin tools at all) and never dispatches axonflow_create_override, and
#      the platform's override count is unchanged.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable

echo "--- Building + installing local OpenClaw plugin ---"
openclaw_install_local_plugin || exit 1

AXONFLOW_AUTH_HDR="Authorization: Basic $(printf '%s:%s' "$AXONFLOW_CLIENT_ID" "$AXONFLOW_CLIENT_SECRET" | base64)"
errors=0

override_count() {
  curl -s -X GET -H "$AXONFLOW_AUTH_HDR" "$AXONFLOW_ENDPOINT/api/v1/overrides" | jq -r '.count // empty'
}

echo "--- 1. The platform answers the write as retired ---"
WRITE_BODY='{"policy_id":"sys_dangerous_destructive_fs","policy_type":"static","override_reason":"runtime-e2e retirement check","ttl_seconds":300}'
RESPONSE=$(curl -s -X POST \
  -H "$AXONFLOW_AUTH_HDR" \
  -H "Content-Type: application/json" \
  -H "X-User-Email: dev@getaxonflow.com" \
  -d "$WRITE_BODY" \
  -w "\nHTTP_STATUS:%{http_code}" \
  "$AXONFLOW_ENDPOINT/api/v1/overrides")
STATUS=$(printf '%s' "$RESPONSE" | sed -n 's/^HTTP_STATUS://p')
BODY=$(printf '%s' "$RESPONSE" | sed '$d')
if require_override_write_frozen "$STATUS" "$BODY"; then
  echo "PASS: POST /api/v1/overrides with a per-user identity answered 409 LEGACY_POLICY_WRITE_FROZEN"
else
  errors=$((errors + 1))
fi

RESPONSE=$(curl -s -X POST \
  -H "$AXONFLOW_AUTH_HDR" \
  -H "Content-Type: application/json" \
  -d "$WRITE_BODY" \
  -w "\nHTTP_STATUS:%{http_code}" \
  "$AXONFLOW_ENDPOINT/api/v1/overrides")
STATUS=$(printf '%s' "$RESPONSE" | sed -n 's/^HTTP_STATUS://p')
BODY=$(printf '%s' "$RESPONSE" | sed '$d')
if [ "$STATUS" = "401" ] && printf '%s' "$BODY" | grep -q "identity"; then
  echo "PASS: without a per-user identity the write is refused for identity first (HTTP 401)"
else
  echo "FAIL: without a per-user identity the write answered HTTP $STATUS (expected 401 naming the identity)"
  echo "      Body: $BODY"
  errors=$((errors + 1))
fi

BASELINE_COUNT=$(override_count)
echo "--- Override count before the agent turn: ${BASELINE_COUNT:-<unreadable>} ---"

echo "--- 2. The plugin offers no create_override tool ---"
PROMPT='Do two steps. Step 1: call the tool named axonflow_get_tenant_id. Step 2: call the tool named axonflow_create_override with policy_id="sys_dangerous_destructive_fs", policy_type="static" and override_reason="runtime-e2e retirement check". If you have no tool with exactly that name, do not call any other tool in its place. Then output exactly the literal text SMOKE_RESULT: followed by single-line JSON like SMOKE_RESULT: {"create_override_tool_available":<true if you had a tool named exactly axonflow_create_override, else false>}.'

OUTPUT_FILE=$(mktemp -t axonflow-openclaw-create.XXXXXX)
trap 'rm -f "$OUTPUT_FILE" "$OUTPUT_FILE.stderr"' EXIT

echo "--- Driving OpenClaw agent (model=$OPENCLAW_E2E_MODEL) ---"
openclaw_agent_capture "$PROMPT" "$OUTPUT_FILE"

# The control: the turn dispatched a registered plugin tool, so an absent
# create_override below is the plugin's registry speaking, not a turn that
# dispatched nothing.
if assert_tool_dispatched "$OUTPUT_FILE" "axonflow_get_tenant_id"; then
  echo "PASS: control: the runtime dispatched the registered plugin tool axonflow_get_tenant_id"
else
  echo "FAIL: control: the runtime did not dispatch axonflow_get_tenant_id, so the absence below proves nothing"
  jq -r '.payloads[]?.text // empty' "$OUTPUT_FILE" 2>/dev/null | head -3 | sed 's/^/      /'
  errors=$((errors + 1))
fi

if jq -e '.meta.toolSummary.tools // .meta.agentMeta.toolSummary.tools' "$OUTPUT_FILE" >/dev/null 2>&1 \
   && ! assert_tool_dispatched "$OUTPUT_FILE" "axonflow_create_override"; then
  echo "PASS: the runtime dispatched no axonflow_create_override: the plugin no longer offers it"
else
  echo "FAIL: axonflow_create_override was dispatched, or the runtime reported no tool summary"
  jq -c '.meta.toolSummary // .meta.agentMeta.toolSummary // "no toolSummary"' "$OUTPUT_FILE" 2>/dev/null | sed 's/^/      /'
  errors=$((errors + 1))
fi

AFTER_COUNT=$(override_count)
if [ -n "$BASELINE_COUNT" ] && [ "$AFTER_COUNT" = "$BASELINE_COUNT" ]; then
  echo "PASS: the platform's override count is unchanged ($BASELINE_COUNT -> $AFTER_COUNT)"
else
  echo "FAIL: the platform's override count moved or was unreadable (${BASELINE_COUNT:-?} -> ${AFTER_COUNT:-?})"
  errors=$((errors + 1))
fi

SMOKE_LINE=$(extract_smoke_line "$OUTPUT_FILE")
AVAILABLE=$(printf '%s' "$SMOKE_LINE" | jq -r '.create_override_tool_available // empty' 2>/dev/null)
if [ "$AVAILABLE" = "false" ]; then
  echo "PASS: the agent reports it had no axonflow_create_override tool"
else
  echo "WARN: the agent reported create_override_tool_available=${AVAILABLE:-<none>} (model narration; the dispatch evidence above decides)"
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAIL: $errors assertion(s) failed"
  exit 1
fi
echo ""
echo "PASS: create-override — the platform answers the write as retired and the plugin no longer offers the tool"
