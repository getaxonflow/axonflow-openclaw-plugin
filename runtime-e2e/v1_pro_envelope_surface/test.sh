#!/usr/bin/env bash
# V1 Plugin Pro envelope-surface runtime proof for the OpenClaw plugin.
#
# Drives the plugin's REAL upgrade-prompt module (compiled
# `dist/upgrade-prompt.js` after `npm run build`) against a REAL 429
# envelope captured live from the REAL hosted agent at
# https://try.getaxonflow.com.
#
# Per HARD RULE #0: the envelope bytes that flow into `handleEnvelope`
# are the bytes the agent emitted to the wire seconds earlier. No
# fixtures, no recorded responses.
#
# Approach (parallel to the bash plugins' v1_pro_envelope_surface test):
#   1. DB-direct seed `community_saas_daily_usage = 200` for a synthetic
#      tenant (loop-to-trip-cap on prod hits the per-IP burst limiter
#      before the daily cap, and that path doesn't carry the V1 envelope).
#   2. Single POST to /api/v1/audit/tool-call → 429 with the V1 envelope.
#   3. Pipe the captured wire bytes into a small Node driver that
#      requires `dist/upgrade-prompt.js` + invokes `handleEnvelope`.
#   4. Assert: rc=0 (envelope detected), wording printed via the logger,
#      throttle-until file stamped under XDG_CACHE_HOME/axonflow.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HELPER_JS="${PLUGIN_DIR}/dist/upgrade-prompt.js"

AGENT_URL="${AGENT_URL:-https://try.getaxonflow.com}"
REGION="${REGION:-us-east-1}"
STACK="${STACK:-}"

EXPECTED_WORDING="Pro raises this to 2,000/day"
EXPECTED_BUY_URL="https://buy.stripe.com/bJe28qbztcdVchjdkw8k800"

UTC_TS=$(date -u +%Y%m%dT%H%M%SZ)
EVIDENCE="$SCRIPT_DIR/EVIDENCE/$UTC_TS"
mkdir -p "$EVIDENCE"

if [ ! -f "$HELPER_JS" ]; then
  echo "Building plugin so dist/upgrade-prompt.js exists..."
  ( cd "$PLUGIN_DIR" && npm run build >"$EVIDENCE/build.log" 2>&1 ) || {
    echo "FAIL: npm run build failed — see $EVIDENCE/build.log"
    exit 1
  }
fi

if [ ! -f "$HELPER_JS" ]; then
  echo "FAIL: dist/upgrade-prompt.js missing after build at $HELPER_JS"
  exit 1
fi

for tool in curl jq aws openssl python3 node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "SKIP: $tool not on PATH"
    exit 0
  fi
done

if ! python3 -c "import bcrypt" >/dev/null 2>&1; then
  echo "SKIP: python3 'bcrypt' module not installed (pip install bcrypt)"
  exit 0
fi
BCRYPT_DIR=$(python3 -c "import bcrypt, os; print(os.path.dirname(os.path.dirname(bcrypt.__file__)))" 2>/dev/null)
if [ -n "$BCRYPT_DIR" ]; then
  export PYTHONPATH="${BCRYPT_DIR}${PYTHONPATH:+:${PYTHONPATH}}"
fi

if ! curl -sSf -o /dev/null --max-time 10 "${AGENT_URL}/health"; then
  echo "SKIP: agent /health not reachable at $AGENT_URL"
  exit 0
fi

# Auto-discover stack matching agent host (mirrors bash plugins').
if [ -z "$STACK" ]; then
  case "$AGENT_URL" in
    *try-staging*) PREFIX='axonflow-community-saas-staging-2' ;;
    *try.getaxonflow*) PREFIX='axonflow-community-saas-2' ;;
    *) echo "SKIP: cannot auto-discover stack for AGENT_URL=$AGENT_URL"; exit 0 ;;
  esac
  STACK=$(aws cloudformation list-stacks --region "$REGION" \
    --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
    --query "StackSummaries[?starts_with(StackName, '$PREFIX') && !contains(StackName, 'staging-2') && !contains(StackName, 'alarm') && !contains(StackName, 'synth')].StackName" \
    --output text 2>/dev/null | tr '\t' '\n' | sort -r | head -1)
fi
if [ -z "$STACK" ] || [ "$STACK" = "None" ]; then
  echo "SKIP: could not auto-discover community-saas stack"
  exit 0
fi
ORCH_TASK=$(aws ecs list-tasks --region "$REGION" --cluster "${STACK}-cluster" \
  --service-name "${STACK}-orchestrator-service" --query 'taskArns[0]' --output text 2>/dev/null)
if [ -z "$ORCH_TASK" ] || [ "$ORCH_TASK" = "None" ]; then
  echo "SKIP: no running orchestrator task in cluster ${STACK}-cluster"
  exit 0
fi
DB_HOST=$(aws rds describe-db-instances --region "$REGION" \
  --query "DBInstances[?DBInstanceIdentifier == '${STACK}-db'].Endpoint.Address" \
  --output text 2>/dev/null | head -1)
if [ -z "$DB_HOST" ] || [ "$DB_HOST" = "None" ]; then
  echo "SKIP: could not resolve DB_HOST for $STACK"
  exit 0
fi
DB_PASS=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "${STACK}-db-password" --query SecretString --output text 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["password"])' 2>/dev/null)
if [ -z "$DB_PASS" ]; then
  echo "SKIP: could not resolve DB_PASS from ${STACK}-db-password SM secret"
  exit 0
fi

DB_LIB="${PLUGIN_DIR}/../axonflow-enterprise/runtime-e2e/v1_paid_tier_staging/lib/db_helpers.sh"
if [ ! -f "$DB_LIB" ]; then
  echo "SKIP: db_helpers.sh not found at $DB_LIB (sibling axonflow-enterprise checkout required)"
  exit 0
fi
export STACK ORCH_TASK DB_HOST DB_PASS REGION
# shellcheck disable=SC1090
source "$DB_LIB"

# Hermetic cache so the helper's throttle-until lands in a tmp path, not
# the operator's real ~/.cache/axonflow.
TEST_CACHE=$(mktemp -d -t axonflow-openclaw-v1env.XXXXXX)
# OpenClaw's axonflowCacheDir() honours AXONFLOW_CACHE_DIR as the highest-
# priority override (see src/cache-dir.ts).
export AXONFLOW_CACHE_DIR="$TEST_CACHE/axonflow"

TENANT="cs_e2e_openclaw_envelope_$(date -u +%s)"
SECRET="synth-tok-$(openssl rand -hex 4)"
cleanup() {
  rm -rf "$TEST_CACHE" 2>/dev/null || true
  if [ -n "${TENANT:-}" ]; then
    db_run_sql "DELETE FROM community_saas_daily_usage WHERE tenant_id = '${TENANT}';" >/dev/null 2>&1 || true
    db_run_sql "DELETE FROM community_saas_registrations WHERE tenant_id = '${TENANT}';" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "AGENT_URL=$AGENT_URL"
echo "STACK=$STACK"
echo "TENANT=$TENANT"
echo "AXONFLOW_CACHE_DIR=$AXONFLOW_CACHE_DIR"
echo "EVIDENCE=$EVIDENCE"

echo "Preflight: install postgresql-client in orchestrator task ${ORCH_TASK##*/}"
aws ecs execute-command --region "$REGION" \
  --cluster "${STACK}-cluster" --task "$ORCH_TASK" --container orchestrator \
  --interactive --command "sh -c 'apk add --no-cache postgresql-client >/dev/null 2>&1 && echo psql-installed'" \
  2>&1 | grep -E 'psql-installed|already installed|^ERROR' | head -3 || true

echo "Step 1: register synthetic tenant via DB direct insert"
if ! db_register_tenant "$TENANT" "$SECRET" "v1-pro-openclaw-envelope-e2e"; then
  echo "FAIL: tenant registration"
  exit 1
fi

echo "Step 2: seed daily_usage = 200"
if ! db_set_daily_usage "$TENANT" 200; then
  echo "FAIL: daily_usage seeding"
  exit 1
fi
USAGE=$(db_get_daily_usage "$TENANT")
if [ "$USAGE" != "200" ]; then
  echo "FAIL: daily_usage seed verification (got '$USAGE', want 200)"
  exit 1
fi

echo "Step 3: capture wire envelope from /api/v1/audit/tool-call (expect 429)"
PAYLOAD='{"tool_name":"v1_envelope_e2e","tool_type":"runtime_e2e","input":{"probe":"daily_quota_envelope"},"success":true}'
ENVELOPE_BODY="$EVIDENCE/envelope_body.json"
ENVELOPE_HEADERS="$EVIDENCE/envelope_headers.txt"
TRIP_HTTP=$(curl -sS -D "$ENVELOPE_HEADERS" -o "$ENVELOPE_BODY" -w '%{http_code}' \
  -X POST "${AGENT_URL}/api/v1/audit/tool-call" \
  -u "${TENANT}:${SECRET}" -H 'Content-Type: application/json' \
  --max-time 10 \
  -d "$PAYLOAD" 2>/dev/null) || TRIP_HTTP="000"
if [ "$TRIP_HTTP" != "429" ]; then
  echo "FAIL: expected 429 from capped tenant, got $TRIP_HTTP"
  cat "$ENVELOPE_BODY" 2>/dev/null
  exit 1
fi

# Pretty-print envelope for evidence.
jq . "$ENVELOPE_BODY" >"$EVIDENCE/envelope_body_pretty.json" 2>/dev/null || true

echo "Step 4: assert wire envelope shape"
PASS=true
fail() { echo "FAIL: $1"; PASS=false; }
[ "$(jq -r '.limit_type // empty' "$ENVELOPE_BODY")" = "daily_quota" ] || fail "envelope.limit_type not 'daily_quota'"
[ "$(jq -r '.tier // empty' "$ENVELOPE_BODY")" = "Free" ] || fail "envelope.tier not 'Free'"
WORD=$(jq -r '.upgrade.wording // empty' "$ENVELOPE_BODY")
echo "$WORD" | grep -qF "$EXPECTED_WORDING" || fail "envelope.upgrade.wording missing locked phrase '$EXPECTED_WORDING'"
[ "$(jq -r '.upgrade.buy_url // empty' "$ENVELOPE_BODY")" = "$EXPECTED_BUY_URL" ] || fail "envelope.upgrade.buy_url unexpected"
H_TIER=$(grep -i '^x-axonflow-tier-limit:' "$ENVELOPE_HEADERS" | tr -d '\r' | awk '{print $2}')
[ "$H_TIER" = "daily_quota" ] || fail "X-Axonflow-Tier-Limit header missing/wrong: '$H_TIER'"
H_RETRY=$(grep -i '^retry-after:' "$ENVELOPE_HEADERS" | tr -d '\r' | awk '{print $2}')
{ [ -n "$H_RETRY" ] && [[ "$H_RETRY" =~ ^[0-9]+$ ]]; } || fail "Retry-After header missing/non-numeric: '$H_RETRY'"

echo "Step 5: drive the REAL TS upgrade-prompt module against the captured envelope"
DRIVER_JS="$EVIDENCE/driver.cjs"
cat >"$DRIVER_JS" <<'NODE'
"use strict";

const fs = require("node:fs");

if (process.argv.length !== 5) {
  console.error("usage: node driver.cjs <module> <body-file> <retry-after-seconds>");
  process.exit(2);
}
const [, , modulePath, bodyPath, retryAfter] = process.argv;
const mod = require(modulePath);

const body = JSON.parse(fs.readFileSync(bodyPath, "utf8"));
const messages = [];
const logger = {
  info: (m) => messages.push(m),
  warn: (m) => messages.push(m),
  error: (m) => messages.push(m),
};

const result = mod.handleEnvelope({
  status: 429,
  body,
  retryAfterHeader: retryAfter,
  logger,
});

const stillActive = mod.isThrottleActive();
const out = { result, messages, stillActive };
fs.writeFileSync(process.env.OUT_PATH, JSON.stringify(out, null, 2));

const status = stillActive ? 0 : 1;
process.exit(status);
NODE

DRIVER_OUT="$EVIDENCE/driver_out.json"
OUT_PATH="$DRIVER_OUT" node "$DRIVER_JS" "$HELPER_JS" "$ENVELOPE_BODY" "$H_RETRY"
DRIVER_RC=$?
echo "  driver rc=$DRIVER_RC out=$(wc -c <"$DRIVER_OUT") bytes"

if [ "$DRIVER_RC" -ne 0 ]; then
  fail "isThrottleActive() did not return true after handleEnvelope ran"
fi

DETECTED=$(jq -r 'if .result.detected == null then "null" else (.result.detected | tostring) end' "$DRIVER_OUT")
[ "$DETECTED" = "true" ] || fail "handleEnvelope.result.detected != true (got '$DETECTED')"
WORDING_SURFACED=$(jq -r 'if .result.wordingSurfaced == null then "null" else (.result.wordingSurfaced | tostring) end' "$DRIVER_OUT")
[ "$WORDING_SURFACED" = "true" ] || fail "handleEnvelope.result.wordingSurfaced != true on first call (got '$WORDING_SURFACED')"
LOG_HAS_WORDING=$(jq -r --arg w "$EXPECTED_WORDING" '[.messages[] | select(contains($w))] | length' "$DRIVER_OUT")
[ "$LOG_HAS_WORDING" -ge 1 ] || fail "logger did not receive the locked wording (got $LOG_HAS_WORDING matches)"
LOG_HAS_URL=$(jq -r --arg u "$EXPECTED_BUY_URL" '[.messages[] | select(contains($u))] | length' "$DRIVER_OUT")
[ "$LOG_HAS_URL" -ge 1 ] || fail "logger did not receive the locked buy URL (got $LOG_HAS_URL matches)"

THROTTLE_FILE="$AXONFLOW_CACHE_DIR/throttle-until"
if [ ! -f "$THROTTLE_FILE" ]; then
  fail "throttle file not stamped at $THROTTLE_FILE"
else
  cp "$THROTTLE_FILE" "$EVIDENCE/throttle-until.txt"
  THROTTLE_EPOCH=$(awk 'NR==1 {print $1}' "$THROTTLE_FILE")
  NOW=$(date -u +%s)
  if [ -z "$THROTTLE_EPOCH" ] || ! [[ "$THROTTLE_EPOCH" =~ ^[0-9]+$ ]] || [ "$THROTTLE_EPOCH" -le "$NOW" ]; then
    fail "throttle deadline not in future (got '$THROTTLE_EPOCH'; now=$NOW)"
  else
    echo "  throttle deadline: $THROTTLE_EPOCH (in $((THROTTLE_EPOCH - NOW))s)"
  fi
fi

echo "Step 6: re-invoke handleEnvelope — once-per-UTC-day stamp must suppress wording"
DRIVER_OUT2="$EVIDENCE/driver_out_run2.json"
OUT_PATH="$DRIVER_OUT2" node "$DRIVER_JS" "$HELPER_JS" "$ENVELOPE_BODY" "$H_RETRY"
WORDING_RUN2=$(jq -r 'if .result.wordingSurfaced == null then "null" else (.result.wordingSurfaced | tostring) end' "$DRIVER_OUT2")
[ "$WORDING_RUN2" = "false" ] || fail "wording was re-emitted on second handler invocation (once-per-day stamp not honoured; got '$WORDING_RUN2')"

{
  echo "OpenClaw plugin V1 Plugin Pro envelope-surface runtime proof — $UTC_TS"
  echo "AGENT_URL=$AGENT_URL"
  echo "STACK=$STACK"
  echo "TENANT=$TENANT"
  echo "Driver rc (run 1): $DRIVER_RC"
  echo "wordingSurfaced run1: $WORDING_SURFACED, run2: $WORDING_RUN2"
  echo "Result: $($PASS && echo PASS || echo FAIL)"
} | tee "$EVIDENCE/summary.txt"

if $PASS; then
  echo
  echo "PASS — OpenClaw plugin module surfaces V1 envelope and honours back-off"
  exit 0
else
  echo
  echo "FAIL — see $EVIDENCE/ for evidence"
  exit 1
fi
