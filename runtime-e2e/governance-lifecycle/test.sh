#!/usr/bin/env bash
# OpenClaw runtime E2E: full W2 governance lifecycle (rule #1 + integration)
#
# Drives a real OpenClaw agent through the full create→list→revoke→list
# →audit-search chain in one session. Asserts state transitions: count
# went up, then back down. Server-side check confirms the revoke.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable

echo "--- Building + installing local OpenClaw plugin ---"
openclaw_install_local_plugin || exit 1

AXONFLOW_AUTH_HDR="Authorization: Basic $(printf '%s:%s' "$AXONFLOW_CLIENT_ID" "$AXONFLOW_CLIENT_SECRET" | base64)"

# Pre-flight probe: confirm the policy is overridable.
PROBE_RESPONSE=$(curl -s -X POST \
  -H "$AXONFLOW_AUTH_HDR" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: local-dev-org" \
  -H "X-User-Email: dev@getaxonflow.com" \
  -d "{\"policy_id\":\"sys_pii_email\",\"policy_type\":\"static\",\"override_reason\":\"lifecycle-prereq-probe\",\"ttl_seconds\":60}" \
  -w "\nHTTP_STATUS:%{http_code}" \
  "$AXONFLOW_ENDPOINT/api/v1/overrides")
PROBE_STATUS=$(printf '%s' "$PROBE_RESPONSE" | sed -n 's/^HTTP_STATUS://p')
PROBE_BODY=$(printf '%s' "$PROBE_RESPONSE" | sed '$d')

require_override_preflight "$PROBE_STATUS" "$PROBE_BODY" || exit 1

PROBE_ID=$(printf '%s' "$PROBE_BODY" | jq -r '.id // empty')
if [ -n "$PROBE_ID" ]; then
  curl -s -X DELETE \
    -H "$AXONFLOW_AUTH_HDR" \
    -H "X-Tenant-ID: local-dev-org" \
    -H "X-User-Email: dev@getaxonflow.com" \
    "$AXONFLOW_ENDPOINT/api/v1/overrides/$PROBE_ID" >/dev/null
fi

BASELINE_COUNT=$(curl -s -X GET \
  -H "$AXONFLOW_AUTH_HDR" \
  -H "X-Tenant-ID: local-dev-org" \
  "$AXONFLOW_ENDPOINT/api/v1/overrides" | jq -r '.count // 0')
echo "--- Baseline override count: $BASELINE_COUNT ---"

REASON_TAG="lifecycle-test-$(date +%s)-$RANDOM"
# Window start + read identity for the independent audit-trail check below.
# Captured BEFORE the agent turn so the window contains only this run's rows, and
# sent with the identity the plugin itself uses so the check reads the same scope
# the plugin gets rather than a narrower one.
LIFECYCLE_WINDOW_START=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=120)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
set_audit_read_identity_args
LIFECYCLE_HDR_FILE=$(mktemp -t axonflow-lifecycle-hdr.XXXXXX)
curl -s -D "$LIFECYCLE_HDR_FILE" -o /dev/null -X POST \
  -H "$AXONFLOW_AUTH_HDR" -H "Content-Type: application/json" \
  "${AUDIT_READ_IDENTITY_ARGS[@]+"${AUDIT_READ_IDENTITY_ARGS[@]}"}" \
  -d '{"limit":1}' "$AXONFLOW_ENDPOINT/api/v1/audit/search"
AUDIT_READ_SCOPE=$(tr -d '\r' < "$LIFECYCLE_HDR_FILE" \
  | awk 'BEGIN{IGNORECASE=1} /^X-Axonflow-Read-Scope:/ {print $2}' | tail -1)

PROMPT="You are running a 5-step governance lifecycle smoke test. Execute each step in order using the named tool — do not invent tools or reorder.

Step 1: Call axonflow_list_overrides with no arguments. Note the count value.

Step 2: Call axonflow_create_override with policy_id=\"sys_pii_email\", policy_type=\"static\", and override_reason=\"$REASON_TAG\". Capture the id from the response — call it CREATED_ID.

Step 3: Call axonflow_list_overrides again with no arguments. Note the new count value and verify CREATED_ID is in the array.

Step 4: Call axonflow_revoke_override with override_id=CREATED_ID.

Step 5: Call axonflow_list_overrides one more time with no arguments. Note the count value (should be back to baseline).

Output exactly the literal text SMOKE_RESULT: followed by a single-line JSON like SMOKE_RESULT: {\"baseline_count\":N1,\"after_create_count\":N2,\"after_revoke_count\":N3,\"created_id\":\"...\",\"revoke_dispatched\":true|false}."

OUTPUT_FILE=$(mktemp -t axonflow-openclaw-lifecycle.XXXXXX)
cleanup() {
  if [ -n "${REASON_TAG:-}" ]; then
    LEAKED_IDS=$(curl -s -X GET \
      -H "$AXONFLOW_AUTH_HDR" \
      -H "X-Tenant-ID: local-dev-org" \
      "$AXONFLOW_ENDPOINT/api/v1/overrides" \
      | jq -r --arg t "$REASON_TAG" '.overrides[]? | select(.override_reason == $t) | .id' 2>/dev/null)
    for lid in $LEAKED_IDS; do
      curl -s -X DELETE \
        -H "$AXONFLOW_AUTH_HDR" \
        -H "X-Tenant-ID: local-dev-org" \
        -H "X-User-Email: dev@getaxonflow.com" \
        "$AXONFLOW_ENDPOINT/api/v1/overrides/$lid" >/dev/null 2>&1 || true
    done
  fi
  rm -f "${OUTPUT_FILE:-}" "${LIFECYCLE_HDR_FILE:-}"
}
trap cleanup EXIT

echo "--- Driving OpenClaw agent through the full W2 lifecycle ---"
openclaw_agent_capture "$PROMPT" "$OUTPUT_FILE"

errors=0

# The lifecycle numbers below are all MODEL-REPORTED. Without this the suite
# passes on a turn that made no tool call at all and narrated plausible counts —
# the strongest single evidence in OpenClaw's --json output is the tool summary,
# and no suite in this directory was consulting it.
for _tool in axonflow_create_override axonflow_revoke_override axonflow_list_overrides; do
  if assert_tool_in_summary "$OUTPUT_FILE" "$_tool"; then
    echo "PASS: runtime dispatched $_tool"
  else
    echo "FAIL: $_tool never appears in the turn's tool summary or reply — the"
    echo "      counts below would be model narration, not a lifecycle"
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

if [ -z "$SMOKE_LINE" ]; then
  echo "FAIL: agent did not emit SMOKE_RESULT line"
  errors=$((errors + 1))
else
  BASE=$(printf '%s' "$SMOKE_LINE" | jq -r '.baseline_count // empty' 2>/dev/null)
  AFTER_C=$(printf '%s' "$SMOKE_LINE" | jq -r '.after_create_count // empty' 2>/dev/null)
  AFTER_R=$(printf '%s' "$SMOKE_LINE" | jq -r '.after_revoke_count // empty' 2>/dev/null)
  CID=$(printf '%s' "$SMOKE_LINE" | jq -r '.created_id // empty' 2>/dev/null)

  if [ -z "$BASE" ] || [ -z "$AFTER_C" ] || [ -z "$AFTER_R" ]; then
    echo "FAIL: SMOKE_RESULT missing required fields. Got: $SMOKE_LINE"
    errors=$((errors + 1))
  else
    if [ "$AFTER_C" -gt "$BASE" ]; then
      echo "PASS: override count went UP after create ($BASE -> $AFTER_C)"
    else
      echo "FAIL: override count did not increase after create ($BASE -> $AFTER_C)"
      errors=$((errors + 1))
    fi

    if [ "$AFTER_R" -lt "$AFTER_C" ]; then
      echo "PASS: override count went DOWN after revoke ($AFTER_C -> $AFTER_R)"
    else
      echo "FAIL: override count did not decrease after revoke ($AFTER_C -> $AFTER_R)"
      errors=$((errors + 1))
    fi
  fi

  # The independent check must prove the row EXISTED and then went away.
  # Asserting only its absence after the revoke is satisfied by any UUID that
  # was never created, which is precisely what a hallucinating turn produces —
  # so the previous form of this leg passed hardest on the input it exists to
  # catch. The create is evidenced by the audit trail rather than by a live
  # lookup, because by this point the revoke has already removed the row.
  if [ -z "$CID" ]; then
    echo "FAIL: SMOKE_RESULT carried no created_id, so the independent"
    echo "      server-side check cannot run — and it is the only assertion here"
    echo "      that does not come from the model"
    errors=$((errors + 1))
  else
    CREATED_SEEN=$(curl -s -X POST \
      -H "$AXONFLOW_AUTH_HDR" \
      -H "Content-Type: application/json" \
      "${AUDIT_READ_IDENTITY_ARGS[@]+"${AUDIT_READ_IDENTITY_ARGS[@]}"}" \
      -d "{\"limit\":100,\"start_time\":\"$LIFECYCLE_WINDOW_START\"}" \
      "$AXONFLOW_ENDPOINT/api/v1/audit/search" \
      | jq --arg t "$REASON_TAG" '[.entries[]? | select(((.query // "") + (.policy_details.reason // "")) | contains($t))] | length' 2>/dev/null)
    if [ "${CREATED_SEEN:-0}" -ge 1 ]; then
      echo "PASS: the platform's own audit trail records the create for $REASON_TAG (independent of the model)"
    else
      echo "WARN: no audit row carries $REASON_TAG; create evidence rests on the"
      echo "      list-count transition alone (read scope: ${AUDIT_READ_SCOPE:-<unknown>})"
    fi

    SERVER_HAS_ID=$(curl -s -X GET \
      -H "$AXONFLOW_AUTH_HDR" \
      -H "X-Tenant-ID: local-dev-org" \
      "$AXONFLOW_ENDPOINT/api/v1/overrides" | jq --arg id "$CID" '[.overrides[]? | select(.id == $id)] | length')
    if [ "${SERVER_HAS_ID:-1}" = "0" ]; then
      echo "PASS: server-side list_overrides confirms $CID is revoked (independent check)"
    else
      echo "FAIL: server-side list_overrides still shows $CID after revoke"
      errors=$((errors + 1))
    fi
  fi
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAIL: $errors lifecycle assertion(s) failed"
  exit 1
fi

echo ""
echo "PASS: governance-lifecycle (full create→list→revoke→list verified end-to-end)"
