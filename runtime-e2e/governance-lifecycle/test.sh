#!/usr/bin/env bash
# OpenClaw runtime E2E: the W2 governance read path on AxonFlow v11.0.0
# (rule #1 + integration)
#
# Session overrides are retired from AxonFlow v11.0.0, so the lifecycle this
# suite used to drive (create -> list -> revoke -> list) no longer exists. What
# remains is the read path, chained in one agent session: list the overrides,
# search the audit trail, and find no way to create an override. Asserted:
#   - the write is retired on the platform (409 LEGACY_POLICY_WRITE_FROZEN);
#   - the runtime dispatched axonflow_list_overrides and axonflow_audit_search,
#     and never axonflow_create_override or axonflow_revoke_override;
#   - the override count the agent read is the platform's.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable

echo "--- Building + installing local OpenClaw plugin ---"
openclaw_install_local_plugin || exit 1

AXONFLOW_AUTH_HDR="Authorization: Basic $(printf '%s:%s' "$AXONFLOW_CLIENT_ID" "$AXONFLOW_CLIENT_SECRET" | base64)"
errors=0

RESPONSE=$(curl -s -X POST \
  -H "$AXONFLOW_AUTH_HDR" \
  -H "Content-Type: application/json" \
  -H "X-User-Email: dev@getaxonflow.com" \
  -d '{"policy_id":"sys_pii_email","policy_type":"static","override_reason":"lifecycle-retirement-probe","ttl_seconds":60}' \
  -w "\nHTTP_STATUS:%{http_code}" \
  "$AXONFLOW_ENDPOINT/api/v1/overrides")
STATUS=$(printf '%s' "$RESPONSE" | sed -n 's/^HTTP_STATUS://p')
BODY=$(printf '%s' "$RESPONSE" | sed '$d')
require_override_write_frozen "$STATUS" "$BODY" || exit 1
echo "PASS: the override write is retired (409 LEGACY_POLICY_WRITE_FROZEN)"

REST_COUNT=$(curl -s -X GET -H "$AXONFLOW_AUTH_HDR" "$AXONFLOW_ENDPOINT/api/v1/overrides" | jq -r '.count // empty')
echo "--- The platform reports ${REST_COUNT:-<unreadable>} override(s) ---"

PROMPT="You are running a 3-step governance read smoke test. Execute each step in order using the named tool; do not invent tools or reorder.

Step 1: Call axonflow_list_overrides with no arguments. Note the count value.

Step 2: Call axonflow_audit_search with limit=5. Note how many entries it returned.

Step 3: Check whether you have a tool named exactly axonflow_create_override. Do not call any other tool in its place.

Output exactly the literal text SMOKE_RESULT: followed by a single-line JSON like SMOKE_RESULT: {\"override_count\":N,\"audit_entries\":M,\"create_override_tool_available\":true|false}."

OUTPUT_FILE=$(mktemp -t axonflow-openclaw-lifecycle.XXXXXX)
trap 'rm -f "$OUTPUT_FILE" "$OUTPUT_FILE.stderr"' EXIT

echo "--- Driving OpenClaw agent through the governance read path ---"
openclaw_agent_capture "$PROMPT" "$OUTPUT_FILE"

# Model-reported numbers are checked only after the structured dispatch
# evidence: a turn that called nothing could still narrate plausible counts.
for _tool in axonflow_list_overrides axonflow_audit_search; do
  if assert_tool_dispatched "$OUTPUT_FILE" "$_tool"; then
    echo "PASS: runtime dispatched $_tool"
  else
    echo "FAIL: $_tool never appears in the turn's tool summary"
    errors=$((errors + 1))
  fi
done
for _tool in axonflow_create_override axonflow_revoke_override; do
  if jq -e '.meta.toolSummary.tools // .meta.agentMeta.toolSummary.tools' "$OUTPUT_FILE" >/dev/null 2>&1 \
     && ! assert_tool_dispatched "$OUTPUT_FILE" "$_tool"; then
    echo "PASS: runtime dispatched no $_tool (retired)"
  else
    echo "FAIL: $_tool was dispatched, or the runtime reported no tool summary"
    errors=$((errors + 1))
  fi
done

if assert_smoke_result "$OUTPUT_FILE"; then
  echo "PASS: agent emitted SMOKE_RESULT marker"
else
  echo "FAIL: agent did not emit SMOKE_RESULT marker"
  jq -r '.payloads[0].text // empty' "$OUTPUT_FILE" 2>/dev/null | head -3 | sed 's/^/      /'
  errors=$((errors + 1))
fi

SMOKE_LINE=$(extract_smoke_line "$OUTPUT_FILE")
AGENT_COUNT=$(printf '%s' "$SMOKE_LINE" | jq -r '.override_count // empty' 2>/dev/null)
if [ -n "$REST_COUNT" ] && [ "$AGENT_COUNT" = "$REST_COUNT" ]; then
  echo "PASS: the override count the agent read ($AGENT_COUNT) is the platform's"
else
  echo "FAIL: the agent read override_count ${AGENT_COUNT:-<none>}, the platform reports ${REST_COUNT:-<unreadable>}"
  errors=$((errors + 1))
fi
ENTRIES=$(printf '%s' "$SMOKE_LINE" | jq -r '.audit_entries // empty' 2>/dev/null)
case "$ENTRIES" in
  ''|*[!0-9]*)
    echo "FAIL: the agent reported no numeric audit_entries (${ENTRIES:-<none>})"
    errors=$((errors + 1))
    ;;
  *)
    echo "PASS: the audit search returned $ENTRIES entr(ies) to the agent"
    ;;
esac

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAIL: $errors lifecycle assertion(s) failed"
  exit 1
fi

echo ""
echo "PASS: governance-lifecycle (the v11 read path: list -> audit search, the writes retired, verified end-to-end)"
