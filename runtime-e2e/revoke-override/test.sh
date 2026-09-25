#!/usr/bin/env bash
# OpenClaw runtime E2E: delete_override is retired, and the plugin no longer
# offers axonflow_revoke_override (#196)
#
# Session overrides are retired from AxonFlow v11.0.0: DELETE
# /api/v1/overrides/<id> answers 409 LEGACY_POLICY_WRITE_FROZEN whatever the
# id, and the plugin no longer registers axonflow_revoke_override. Both halves,
# on the runtime path:
#   1. the platform: DELETE with a per-user identity answers the 409 code;
#   2. the plugin: a real OpenClaw agent turn dispatches axonflow_get_tenant_id
#      (the control) and never dispatches axonflow_revoke_override.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable

echo "--- Building + installing local OpenClaw plugin ---"
openclaw_install_local_plugin || exit 1

AXONFLOW_AUTH_HDR="Authorization: Basic $(printf '%s:%s' "$AXONFLOW_CLIENT_ID" "$AXONFLOW_CLIENT_SECRET" | base64)"
errors=0

echo "--- 1. The platform answers the delete as retired ---"
FABRICATED_ID="ovr-runtime-e2e-$(date +%s)-$RANDOM"
RESPONSE=$(curl -s -X DELETE \
  -H "$AXONFLOW_AUTH_HDR" \
  -H "X-User-Email: dev@getaxonflow.com" \
  -w "\nHTTP_STATUS:%{http_code}" \
  "$AXONFLOW_ENDPOINT/api/v1/overrides/$FABRICATED_ID")
STATUS=$(printf '%s' "$RESPONSE" | sed -n 's/^HTTP_STATUS://p')
BODY=$(printf '%s' "$RESPONSE" | sed '$d')
if require_override_write_frozen "$STATUS" "$BODY"; then
  echo "PASS: DELETE /api/v1/overrides/$FABRICATED_ID answered 409 LEGACY_POLICY_WRITE_FROZEN"
else
  errors=$((errors + 1))
fi

echo "--- 2. The plugin offers no revoke_override tool ---"
PROMPT="Do two steps. Step 1: call the tool named axonflow_get_tenant_id. Step 2: call the tool named axonflow_revoke_override with override_id=\"$FABRICATED_ID\". If you have no tool with exactly that name, do not call any other tool in its place. Then output exactly the literal text SMOKE_RESULT: followed by single-line JSON like SMOKE_RESULT: {\"revoke_override_tool_available\":<true if you had a tool named exactly axonflow_revoke_override, else false>}."

OUTPUT_FILE=$(mktemp -t axonflow-openclaw-revoke.XXXXXX)
trap 'rm -f "$OUTPUT_FILE" "$OUTPUT_FILE.stderr"' EXIT

echo "--- Driving OpenClaw agent (model=$OPENCLAW_E2E_MODEL) ---"
openclaw_agent_capture "$PROMPT" "$OUTPUT_FILE"

if assert_tool_dispatched "$OUTPUT_FILE" "axonflow_get_tenant_id"; then
  echo "PASS: control: the runtime dispatched the registered plugin tool axonflow_get_tenant_id"
else
  echo "FAIL: control: the runtime did not dispatch axonflow_get_tenant_id, so the absence below proves nothing"
  jq -r '.payloads[]?.text // empty' "$OUTPUT_FILE" 2>/dev/null | head -3 | sed 's/^/      /'
  errors=$((errors + 1))
fi

if jq -e '.meta.toolSummary.tools // .meta.agentMeta.toolSummary.tools' "$OUTPUT_FILE" >/dev/null 2>&1 \
   && ! assert_tool_dispatched "$OUTPUT_FILE" "axonflow_revoke_override"; then
  echo "PASS: the runtime dispatched no axonflow_revoke_override: the plugin no longer offers it"
else
  echo "FAIL: axonflow_revoke_override was dispatched, or the runtime reported no tool summary"
  jq -c '.meta.toolSummary // .meta.agentMeta.toolSummary // "no toolSummary"' "$OUTPUT_FILE" 2>/dev/null | sed 's/^/      /'
  errors=$((errors + 1))
fi

SMOKE_LINE=$(extract_smoke_line "$OUTPUT_FILE")
AVAILABLE=$(printf '%s' "$SMOKE_LINE" | jq -r '.revoke_override_tool_available // empty' 2>/dev/null)
if [ "$AVAILABLE" = "false" ]; then
  echo "PASS: the agent reports it had no axonflow_revoke_override tool"
else
  echo "WARN: the agent reported revoke_override_tool_available=${AVAILABLE:-<none>} (model narration; the dispatch evidence above decides)"
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAIL: $errors assertion(s) failed"
  exit 1
fi
echo ""
echo "PASS: revoke-override — the platform answers the delete as retired and the plugin no longer offers the tool"
