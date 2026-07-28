#!/usr/bin/env bash
# OpenClaw runtime E2E: revoke-override OUTCOME TEST (W2 — rule #1)
#
# Seeds a real override, drives the OpenClaw agent to revoke it via
# axonflow_revoke_override, then asserts SERVER-SIDE that the override
# is in fact revoked. Dispatch alone isn't proof — only the platform's
# own state is.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable

echo "--- Building + installing local OpenClaw plugin ---"
openclaw_install_local_plugin || exit 1

AXONFLOW_AUTH_HDR="Authorization: Basic $(printf '%s:%s' "$AXONFLOW_CLIENT_ID" "$AXONFLOW_CLIENT_SECRET" | base64)"

REASON_TAG="revoke-runtime-e2e-$(date +%s)-$RANDOM"
echo "--- Seeding override with reason tag: $REASON_TAG ---"

CREATE_RESPONSE=$(curl -s -X POST \
  -H "$AXONFLOW_AUTH_HDR" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: local-dev-org" \
  -H "X-User-Email: dev@getaxonflow.com" \
  -d "{\"policy_id\":\"sys_pii_email\",\"policy_type\":\"static\",\"override_reason\":\"$REASON_TAG\",\"ttl_seconds\":300}" \
  -w "\nHTTP_STATUS:%{http_code}" \
  "$AXONFLOW_ENDPOINT/api/v1/overrides")
CREATE_STATUS=$(printf '%s' "$CREATE_RESPONSE" | sed -n 's/^HTTP_STATUS://p')
CREATE_BODY=$(printf '%s' "$CREATE_RESPONSE" | sed '$d')

if [ "$CREATE_STATUS" != "201" ]; then
  # Previously "SKIP:" + exit 0 — green CI in exactly the default posture every
  # user runs, with the seeded override this suite depends on never created.
  require_override_preflight sys_pii_email 60
  echo "FAIL: seeding create_override returned HTTP $CREATE_STATUS despite a healthy pre-flight"
  echo "      Body: $CREATE_BODY"
  exit 1
fi

SEED_ID=$(printf '%s' "$CREATE_BODY" | jq -r '.id')
echo "--- Seeded override id: $SEED_ID ---"

OUTPUT_FILE=$(mktemp -t axonflow-openclaw-revoke.XXXXXX)
cleanup() {
  curl -s -X DELETE \
    -H "$AXONFLOW_AUTH_HDR" \
    -H "X-Tenant-ID: local-dev-org" \
    -H "X-User-Email: dev@getaxonflow.com" \
    "$AXONFLOW_ENDPOINT/api/v1/overrides/$SEED_ID" >/dev/null 2>&1 || true
  rm -f "${OUTPUT_FILE:-}"
}
trap cleanup EXIT

PROMPT="Use the axonflow_revoke_override tool with override_id=\"$SEED_ID\". After the tool call, output exactly the literal text SMOKE_RESULT: followed by a single-line JSON like SMOKE_RESULT: {\"dispatched\":true,\"revoked\":true} on success, or SMOKE_RESULT: {\"dispatched\":true,\"revoked\":false} on error."

echo "--- Driving OpenClaw agent (model=$OPENCLAW_E2E_MODEL) ---"
openclaw_agent_capture "$PROMPT" "$OUTPUT_FILE"

errors=0

if assert_smoke_result "$OUTPUT_FILE"; then
  echo "PASS: agent emitted SMOKE_RESULT marker"
else
  echo "FAIL: agent did not emit SMOKE_RESULT marker"
  errors=$((errors + 1))
fi

# Outcome assertion — server-side state.
SERVER_STATE=$(curl -s -X GET \
  -H "$AXONFLOW_AUTH_HDR" \
  -H "X-Tenant-ID: local-dev-org" \
  "$AXONFLOW_ENDPOINT/api/v1/overrides?include_revoked=true" \
  | jq -r --arg id "$SEED_ID" '.overrides[]? | select(.id == $id) | .revoked_at // ""')

if [ -n "$SERVER_STATE" ] && [ "$SERVER_STATE" != "null" ]; then
  echo "PASS: server-side state shows override $SEED_ID revoked at $SERVER_STATE — outcome verified"
else
  echo "FAIL: server-side state shows override $SEED_ID NOT revoked"
  errors=$((errors + 1))
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAIL: $errors outcome-test assertion(s) failed"
  exit 1
fi
echo ""
echo "PASS: revoke-override outcome — agent dispatched, platform revoked, server state confirmed"
