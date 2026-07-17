#!/usr/bin/env bash
# OpenClaw runtime E2E: caller-name-audit (getaxonflow/axonflow-enterprise#2912)
#
# PR #156 changed auditToolCall() in src/axonflow-client.ts to send
# `caller_name: "openclaw"` on the audit/tool-call payload instead of the
# misleadingly-named `tool_type: "openclaw"`. The platform side of #2912
# (axonflow-enterprise#2953) writes policy_details.caller_name for new
# audit_logs rows and stops writing policy_details.tool_type entirely.
#
# Outcome verification, not just dispatch (W2 — rule #1, mirrors
# audit-search/test.sh): this drives a REAL OpenClaw agent through a real
# registered tool (axonflow_get_tenant_id). That fires the after_tool_call
# hook -> auditToolCall() -> POST /api/v1/audit/tool-call against a live
# AxonFlow stack. We then read the resulting audit_logs row directly from
# Postgres and assert policy_details.caller_name == "openclaw" and
# policy_details does NOT contain the legacy tool_type key.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable

: "${AXONFLOW_DB_URL:=postgresql://axonflow:localdev123@localhost:5432/axonflow}"
: "${AXONFLOW_DB_CONTAINER:=axonflow-postgres}"

# Resolve a way to run SQL against the platform's Postgres: prefer a local
# psql + AXONFLOW_DB_URL, fall back to `docker exec` into the compose
# container (axonflow-enterprise's docker-compose.yml pins
# `container_name: axonflow-postgres` for the default local-dev stack) —
# the same escape hatch used when no local pg client is installed.
DB_MODE=""
if command -v psql >/dev/null 2>&1 && psql "$AXONFLOW_DB_URL" -t -A -c "SELECT 1" >/dev/null 2>&1; then
  DB_MODE="psql"
elif command -v docker >/dev/null 2>&1 && docker exec "$AXONFLOW_DB_CONTAINER" psql -U axonflow -d axonflow -t -A -c "SELECT 1" >/dev/null 2>&1; then
  DB_MODE="docker"
else
  echo "SKIP: cannot reach AxonFlow Postgres via psql (\$AXONFLOW_DB_URL=$AXONFLOW_DB_URL) or docker exec into \$AXONFLOW_DB_CONTAINER=$AXONFLOW_DB_CONTAINER"
  exit 0
fi
echo "--- DB access mode: $DB_MODE ---"

db_query() {
  local sql="$1"
  if [ "$DB_MODE" = "psql" ]; then
    psql "$AXONFLOW_DB_URL" -t -A -c "$sql" 2>/dev/null
  else
    docker exec "$AXONFLOW_DB_CONTAINER" psql -U axonflow -d axonflow -t -A -c "$sql" 2>/dev/null
  fi
}

echo "--- Building + installing local OpenClaw plugin ---"
openclaw_install_local_plugin || exit 1

# The tool we drive the agent through. audit_logs.query is written by the
# platform as literal "Tool: <tool_name>" (see LogToolCallAudit in
# axonflow-enterprise/platform/orchestrator/audit_logger.go), which gives us
# a disambiguating filter alongside a DB-clock start marker.
MARKER_TOOL="axonflow_get_tenant_id"

START_TS=$(db_query "SELECT NOW()::text")
if [ -z "$START_TS" ]; then
  echo "FAIL: could not read current DB time"
  exit 1
fi
echo "--- Start marker timestamp (DB clock): $START_TS ---"

echo "--- Driving OpenClaw agent through a real governed tool call ---"
OUTPUT_FILE=$(mktemp -t axonflow-openclaw-caller-name-audit.XXXXXX)
trap 'rm -f "$OUTPUT_FILE"' EXIT

openclaw_agent_capture \
  "Call the axonflow_get_tenant_id tool. Output only the raw tool result, nothing else." \
  "$OUTPUT_FILE"

REPLY=$(jq -r '.payloads[0].text // ""' "$OUTPUT_FILE" 2>/dev/null)
if echo "$REPLY" | grep -qiE "not (found|available|see)|don.t (see|have|find)|no .* tool|unknown tool"; then
  echo "FAIL: agent could not find/call $MARKER_TOOL tool"
  echo "  Reply: $(echo "$REPLY" | head -3)"
  exit 1
fi
echo "PASS: agent invoked $MARKER_TOOL (reply did not indicate a missing tool)"

echo "--- Waiting for the fire-and-forget audit write to land in audit_logs ---"
ROW=""
for _ in $(seq 1 15); do
  ROW=$(db_query "SELECT policy_details::text FROM audit_logs WHERE query = 'Tool: ${MARKER_TOOL}' AND \"timestamp\" >= '${START_TS}'::timestamptz ORDER BY \"timestamp\" DESC LIMIT 1;")
  [ -n "$ROW" ] && break
  sleep 1
done

if [ -z "$ROW" ]; then
  echo "FAIL: no audit_logs row for Tool: ${MARKER_TOOL} landed within 15s"
  exit 1
fi
echo "--- audit_logs.policy_details: $ROW ---"

errors=0

CALLER_NAME=$(echo "$ROW" | jq -r '.caller_name // empty')
if [ "$CALLER_NAME" = "openclaw" ]; then
  echo "PASS: policy_details.caller_name == \"openclaw\""
else
  echo "FAIL: policy_details.caller_name expected \"openclaw\", got \"$CALLER_NAME\""
  errors=$((errors + 1))
fi

if echo "$ROW" | jq -e 'has("tool_type") | not' >/dev/null 2>&1; then
  echo "PASS: policy_details does not contain the legacy tool_type key"
else
  echo "FAIL: policy_details still contains tool_type (got: $(echo "$ROW" | jq -c '.tool_type // empty'))"
  errors=$((errors + 1))
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAIL: $errors assertion(s) failed"
  exit 1
fi

echo ""
echo "PASS: caller-name-audit — real OpenClaw tool call wrote caller_name=\"openclaw\" (no tool_type) to audit_logs (#2912/#2953)"
