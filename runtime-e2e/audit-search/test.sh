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
#
# The marker goes in connector_type, NOT in the statement. A check-input audit
# row records `query` as "mcp check-input: <connector_type>" and stores only
# StatementHash for the statement itself (platform/agent/mcp_handler.go) — the
# statement text is deliberately never persisted. A marker embedded in the
# statement is therefore unfindable in `.query` by construction, and the
# pre-flight below could not pass on any platform version. The statement still
# carries the SQLi pattern, so the seed is still a real recorded block.
MARKER="w2-runtime-e2e-audit-marker-$(date +%s)-$RANDOM"
# Window start, captured BEFORE the seed and handed to both the pre-flight and
# the agent, so both read the same small set of rows this run produced.
#
# Without it the agent is asked to find one substring inside the 50 most recent
# audit entries, and the audit table grows with every run on a long-lived stack.
# That was observed failing: at 92 rows the model returned no SMOKE_RESULT at
# all while the pre-flight, the tool dispatch and the marker were all fine, and
# the same suite passed on the next run. A non-deterministic assertion that
# degrades as the table fills is not a gate.
#
# python3 rather than `date -v` / `date -d`: those disagree between BSD and GNU,
# and an $OSTYPE branch adds a second code path that nothing exercises on the
# other host. python3 is one code path and is already a prereq of the sibling
# suites. 120s of slack absorbs clock skew between this host and the platform.
WINDOW_START=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=120)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
echo "--- Seeding audit marker: $MARKER (window start $WINDOW_START) ---"

curl -s -X POST \
  -H "Authorization: Basic $(printf '%s:%s' "$AXONFLOW_CLIENT_ID" "$AXONFLOW_CLIENT_SECRET" | base64)" \
  -H "Content-Type: application/json" \
  -d "{\"connector_type\":\"sql-$MARKER\",\"statement\":\"SELECT * FROM users WHERE id=1 OR 1=1\",\"operation\":\"query\"}" \
  "$AXONFLOW_ENDPOINT/api/v1/mcp/check-input" >/dev/null
sleep 2

# Verify the seed landed before driving the agent.
#
# The probe must send the identity the PLUGIN sends, or it measures a read scope
# the plugin does not use. Since platform 9.10.0 the audit/decisions/overrides
# reads are role-scoped: a shared client credential resolves to a synthetic
# shared identity (<client>@axonflow.local) and reads ZERO rows fail-closed
# (#2950), while a validated per-user token reads that developer's rows. A bare
# Basic-auth curl therefore reports "nothing in the audit log" on a stack whose
# audit log is fine and whose plugin can read it.
set_audit_read_identity_args
AUDIT_HDR_FILE=$(mktemp -t axonflow-audit-hdr.XXXXXX)
AUDIT_SEARCH_RESPONSE=$(curl -s -D "$AUDIT_HDR_FILE" -X POST \
  -H "Authorization: Basic $(printf '%s:%s' "$AXONFLOW_CLIENT_ID" "$AXONFLOW_CLIENT_SECRET" | base64)" \
  -H "Content-Type: application/json" \
  "${AUDIT_READ_IDENTITY_ARGS[@]+"${AUDIT_READ_IDENTITY_ARGS[@]}"}" \
  -d "{\"limit\":50,\"start_time\":\"$WINDOW_START\"}" \
  "$AXONFLOW_ENDPOINT/api/v1/audit/search")
# The platform's own answer to "how wide is this caller's read?", rather than a
# guess derived from an empty array. Absent below platform 9.10.0.
AUDIT_READ_SCOPE=$(tr -d '\r' < "$AUDIT_HDR_FILE" \
  | awk 'BEGIN{IGNORECASE=1} /^X-Axonflow-Read-Scope:/ {print $2}' | tail -1)
DIRECT_HITS=$(printf '%s' "$AUDIT_SEARCH_RESPONSE" \
  | jq --arg m "$MARKER" '[.entries[] | select((.query // "") | contains($m))] | length' 2>/dev/null)
if [ "${DIRECT_HITS:-0}" -lt 1 ]; then
  # Previously "SKIP:" + exit 0 — success reported for precisely the condition
  # that makes the rest of this suite meaningless. If the seeded marker never
  # reaches the audit log, the agent-driven search below has nothing to find,
  # and a green result would say the audit trail works when it does not.
  require_audit_read_scope "$MARKER" "$AUDIT_SEARCH_RESPONSE" "$AUDIT_READ_SCOPE"
  exit 1
fi

# 2. Drive the agent.
PROMPT="Use the axonflow_audit_search tool with limit=50 and start_time=\"$WINDOW_START\" to fetch recent audit events. Then find any entry whose query field contains the substring '$MARKER' and report it. Output exactly the literal text SMOKE_RESULT: followed by a single-line JSON like SMOKE_RESULT: {\"marker_found\":true,\"audit_id\":\"audit_...\"} if you found it, or SMOKE_RESULT: {\"marker_found\":false} otherwise."

OUTPUT_FILE=$(mktemp -t axonflow-openclaw-audit-outcome.XXXXXX)
trap 'rm -f "$OUTPUT_FILE" "${AUDIT_HDR_FILE:-}"' EXIT

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
