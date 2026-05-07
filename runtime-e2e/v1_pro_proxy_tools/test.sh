#!/usr/bin/env bash
# V1 Plugin Pro proxy-tools runtime proof for the OpenClaw plugin.
#
# Drives the COMPILED agent-tool registrations (built from
# `src/agent-tools.ts` + `src/axonflow-client.ts`'s callMCPTool helper)
# against the real hosted agent at https://try.getaxonflow.com.
#
# What this proves:
#   - axonflow_list_pro_features.execute() actually round-trips to
#     /api/v1/mcp-server (initialize → tools/call) and returns the
#     locked V1 Pro feature shape (5 differentiators + $9.99 / 90-day
#     pricing).
#   - axonflow_get_cost_estimate.execute() on a Free-tier tenant lands
#     a Pro-only envelope (limit_type=feature_pro_only) — the tool
#     wrapper renders the locked V1 wording back to the agent as a
#     fail() result, the helper stamps the throttle file, and the
#     once-per-UTC-day stamp gates the prompt.
#
# Per HARD RULE #0: real plugin code (built dist/) against real wire
# bytes from a real registered tenant on prod. No fixtures.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENT_TOOLS_JS="${PLUGIN_DIR}/dist/agent-tools.js"

AGENT_URL="${AGENT_URL:-https://try.getaxonflow.com}"

UTC_TS=$(date -u +%Y%m%dT%H%M%SZ)
EVIDENCE="$SCRIPT_DIR/EVIDENCE/$UTC_TS"
mkdir -p "$EVIDENCE"

for tool in node jq curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "SKIP: $tool not on PATH"
    exit 0
  fi
done

if ! curl -sSf -o /dev/null --max-time 10 "${AGENT_URL}/health"; then
  echo "SKIP: agent /health not reachable at $AGENT_URL"
  exit 0
fi

if [ ! -f "$AGENT_TOOLS_JS" ]; then
  echo "Building plugin so dist/agent-tools.js exists..."
  ( cd "$PLUGIN_DIR" && npm run build >"$EVIDENCE/build.log" 2>&1 ) || {
    echo "FAIL: npm run build failed"
    exit 1
  }
fi

# Register a fresh Free-tier tenant via /api/v1/register. The proxy
# tools authenticate with these credentials.
#
# CREDENTIAL HANDLING:
# - The full register response (which contains the bcrypt-validated
#   `secret` Basic-auth credential) is captured to a TEMP file outside
#   EVIDENCE/, never inside it. EVIDENCE/<ts>/register.json holds a
#   REDACTED copy: tenant_id + a `secret_redacted` field, no live
#   credential. This avoids leaking a working credential into the
#   public-mirrored repo's git history.
# - The .gitignore in this directory also excludes
#   `EVIDENCE/*/register.json` as a belt-and-braces guard against
#   future test-author drift.
RAW_REG_BODY=$(mktemp)
REG_BODY="$EVIDENCE/register.json"
trap 'rm -f "$RAW_REG_BODY" 2>/dev/null || true' EXIT
# Allow caller to pass an already-registered TENANT/SECRET via env to
# bypass /api/v1/register's per-IP 5/hr rate limit. CI uses a fresh
# registration per run; manual / iterative dev re-uses a cached tenant.
TENANT="${TENANT:-}"
SECRET="${SECRET:-}"
TENANT_SOURCE=""
if [ -z "$TENANT" ] || [ -z "$SECRET" ]; then
  EMAIL_TAG=$(date -u +%s)
  REG_HTTP=$(curl -sS -o "$RAW_REG_BODY" -w '%{http_code}' \
    -X POST "${AGENT_URL}/api/v1/register" \
    -H 'Content-Type: application/json' \
    -d "{\"label\":\"v1-pro-proxy-tools-e2e\",\"email\":\"e2e+openclaw-proxy-${EMAIL_TAG}@getaxonflow.com\"}" 2>/dev/null) || REG_HTTP="000"
  if [ "$REG_HTTP" != "200" ] && [ "$REG_HTTP" != "201" ]; then
    echo "SKIP: tenant registration HTTP=$REG_HTTP (per-IP rate limit / per-email cap / connectivity). Pass TENANT=... SECRET=... env to reuse an existing tenant."
    cat "$RAW_REG_BODY" 2>/dev/null
    exit 0
  fi
  TENANT=$(jq -r '.tenant_id' "$RAW_REG_BODY")
  SECRET=$(jq -r '.secret' "$RAW_REG_BODY")
  if [ -z "$TENANT" ] || [ "$TENANT" = "null" ] || [ -z "$SECRET" ] || [ "$SECRET" = "null" ]; then
    echo "FAIL: register response missing tenant_id or secret"
    exit 1
  fi
  TENANT_SOURCE="registered"
  echo "Registered: $TENANT"
else
  TENANT_SOURCE="env"
  echo "Reusing tenant: $TENANT (from env)"
fi

# Idempotency: when reusing an env-supplied tenant, prior runs may have
# left HITL approvals or tenant policies behind which would trip
# Free-tier gates on tests 3 + 4 (1/7d HITL window + 2 active policy
# max). Clear that prior state via the canonical db_helpers.sh ECS-exec
# path. Best-effort — when AWS creds aren't available the cleanup is
# skipped and the operator is responsible for using a fresh tenant.
if [ "$TENANT_SOURCE" = "env" ] && command -v aws >/dev/null 2>&1; then
  DB_LIB="${PLUGIN_DIR}/../axonflow-enterprise/runtime-e2e/v1_paid_tier_staging/lib/db_helpers.sh"
  if [ -f "$DB_LIB" ]; then
    case "$AGENT_URL" in
      *try-staging*) STACK_PREFIX='axonflow-community-saas-staging-2' ;;
      *try.getaxonflow*) STACK_PREFIX='axonflow-community-saas-2' ;;
      *) STACK_PREFIX='' ;;
    esac
    if [ -n "$STACK_PREFIX" ]; then
      DETECTED_STACK=$(aws cloudformation list-stacks --region us-east-1 \
        --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
        --query "StackSummaries[?starts_with(StackName, '$STACK_PREFIX') && !contains(StackName, 'staging-2') && !contains(StackName, 'alarm') && !contains(StackName, 'synth')].StackName" \
        --output text 2>/dev/null | tr '\t' '\n' | sort -r | head -1)
      DETECTED_TASK=$(aws ecs list-tasks --region us-east-1 --cluster "${DETECTED_STACK}-cluster" \
        --service-name "${DETECTED_STACK}-orchestrator-service" --query 'taskArns[0]' --output text 2>/dev/null)
      DETECTED_DB=$(aws rds describe-db-instances --region us-east-1 \
        --query "DBInstances[?DBInstanceIdentifier == '${DETECTED_STACK}-db'].Endpoint.Address" \
        --output text 2>/dev/null | head -1)
      DETECTED_PASS=$(aws secretsmanager get-secret-value --region us-east-1 \
        --secret-id "${DETECTED_STACK}-db-password" --query SecretString --output text 2>/dev/null \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["password"])' 2>/dev/null)
      if [ -n "$DETECTED_STACK" ] && [ -n "$DETECTED_TASK" ] && [ -n "$DETECTED_DB" ] && [ -n "$DETECTED_PASS" ]; then
        export STACK="$DETECTED_STACK" ORCH_TASK="$DETECTED_TASK" DB_HOST="$DETECTED_DB" DB_PASS="$DETECTED_PASS" REGION=us-east-1
        # shellcheck disable=SC1090
        source "$DB_LIB"
        echo "Idempotency: clear hitl_approval_queue + dynamic_policies for $TENANT"
        db_run_sql "DELETE FROM hitl_approval_queue WHERE tenant_id = '${TENANT}'; DELETE FROM dynamic_policies WHERE tenant_id = '${TENANT}';" >/dev/null 2>&1 || true
      fi
    fi
  fi
fi
# Redacted copy lands in EVIDENCE — preserves the breadcrumb (we know
# WHICH tenant the run used) without committing a live credential.
jq -n --arg t "$TENANT" \
      --arg s_prefix "${SECRET:0:8}" \
      --arg src "$TENANT_SOURCE" \
      '{tenant_id: $t, secret_prefix: $s_prefix, secret_redacted: "<redacted-32-chars>", source: $src}' \
  >"$REG_BODY"

# Hermetic cache so the throttle file lands in tmp.
TEST_CACHE=$(mktemp -d -t axonflow-openclaw-proxy.XXXXXX)
export AXONFLOW_CACHE_DIR="$TEST_CACHE/axonflow"
mkdir -p "$AXONFLOW_CACHE_DIR"
cleanup() { rm -rf "$TEST_CACHE" 2>/dev/null || true; }
trap cleanup EXIT

# Build a Node driver that loads the compiled agent-tools, builds the
# tool registry against an AxonFlowClient with our test credentials,
# and invokes each tool's execute().
DRIVER_JS="$EVIDENCE/driver.cjs"
cat >"$DRIVER_JS" <<'NODE'
"use strict";

(async () => {
  const fs = require("node:fs");
  const out = process.env.OUT_PATH;

  const { AxonFlowClient } = require(process.env.PLUGIN_DIR + "/dist/axonflow-client.js");
  const { buildAgentTools } = require(process.env.PLUGIN_DIR + "/dist/agent-tools.js");

  const client = new AxonFlowClient({
    endpoint: process.env.AGENT_URL,
    clientId: process.env.TENANT,
    clientSecret: process.env.SECRET,
    requestTimeoutMs: 15000,
  });
  client.setUpgradePromptLogger({
    info: (m) => console.error("[logger.info]", m),
    warn: (m) => console.error("[logger.warn]", m),
    error: (m) => console.error("[logger.error]", m),
  });

  const tools = buildAgentTools({ current: client });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const results = {};

  // Test 1: list_pro_features (Free-accessible) — should round-trip
  // and return the 5-differentiator + pricing shape.
  try {
    const r = await byName["axonflow_list_pro_features"].execute("call-1", {});
    results.list_pro_features = r;
  } catch (e) {
    results.list_pro_features_error = e instanceof Error ? e.message : String(e);
  }

  // Test 2: get_cost_estimate (Pro-only) — Free tier should land the
  // V1 envelope (limit_type=feature_pro_only). Use the underlying
  // callMCPTool directly first so we can see exactly what comes back
  // (kind=envelope/ok/error/throttled), separately from the agent-tool
  // wrapper's translation into ToolResult.
  try {
    const raw = await client.callMCPTool("axonflow_get_cost_estimate", {
      plan: "test-multi-step-plan-for-cost-estimate",
    });
    results.get_cost_estimate_raw = raw;
  } catch (e) {
    results.get_cost_estimate_raw_error = e instanceof Error ? e.message : String(e);
  }
  try {
    const r = await byName["axonflow_get_cost_estimate"].execute("call-2", {
      plan: "test-multi-step-plan-for-cost-estimate",
    });
    results.get_cost_estimate = r;
  } catch (e) {
    results.get_cost_estimate_error = e instanceof Error ? e.message : String(e);
  }

  // The throttle gate from test 2 is now active. Capture the deadline
  // for assertion + clear the file so tests 3 + 4 round-trip
  // (otherwise they'd all return kind="throttled").
  const path = require("node:path");
  const cacheDir = process.env.AXONFLOW_CACHE_DIR;
  if (cacheDir) {
    try {
      const f = path.join(cacheDir, "throttle-until");
      results.throttle_stamp_after_test2 = fs.readFileSync(f, "utf-8").trim();
    } catch (e) { /* not stamped — caller asserts on results.throttle_stamp_after_test2 */ }
    try { fs.unlinkSync(path.join(cacheDir, "throttle-until")); }
    catch (e) { /* file may not exist; ignore */ }
  }

  // Test 3: request_approval (Free=1/7d rolling) — first call should
  // succeed (Free quota: 1 approval per 7d window); plugin pre-test
  // assumes the synthetic tenant has zero existing HITL approvals.
  try {
    const raw = await client.callMCPTool("axonflow_request_approval", {
      original_query: "delete production-east database — runtime-e2e probe",
      request_type: "shell_command",
      trigger_reason: "destructive_command",
      severity: "high",
    });
    results.request_approval_raw = raw;
  } catch (e) {
    results.request_approval_raw_error = e instanceof Error ? e.message : String(e);
  }

  // Test 4: create_tenant_policy (Free=2 active max) — first call
  // should succeed (synthetic tenant starts with zero active
  // policies). Asserting against the API shape, not on side-effects.
  if (cacheDir) {
    try { fs.unlinkSync(path.join(cacheDir, "throttle-until")); } catch {}
  }
  try {
    const raw = await client.callMCPTool("axonflow_create_tenant_policy", {
      name: `runtime-e2e-policy-${Date.now()}`,
      description: "Synthetic policy created by openclaw v1_pro_proxy_tools runtime-e2e",
      connector_type: "openclaw.Bash",
      pattern: "rm -rf /",
      action: "block",
    });
    results.create_tenant_policy_raw = raw;
  } catch (e) {
    results.create_tenant_policy_raw_error = e instanceof Error ? e.message : String(e);
  }

  // Test 5: get_tenant_id — local tool (no MCP round-trip). Sanity
  // check that it's still callable via buildAgentTools (the cross-
  // plugin parity tool).
  if (cacheDir) {
    try { fs.unlinkSync(path.join(cacheDir, "throttle-until")); } catch {}
  }
  try {
    const r = await byName["axonflow_get_tenant_id"].execute("call-5", {});
    results.get_tenant_id = r;
  } catch (e) {
    results.get_tenant_id_error = e instanceof Error ? e.message : String(e);
  }

  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  process.exit(0);
})();
NODE

DRIVER_OUT="$EVIDENCE/driver_out.json"
DRIVER_LOG="$EVIDENCE/driver.log"
PLUGIN_DIR="$PLUGIN_DIR" AGENT_URL="$AGENT_URL" TENANT="$TENANT" SECRET="$SECRET" \
  OUT_PATH="$DRIVER_OUT" \
  node "$DRIVER_JS" 2>"$DRIVER_LOG"
DRIVER_RC=$?
echo "  driver rc=$DRIVER_RC out=$(wc -c <"$DRIVER_OUT") bytes log=$(wc -c <"$DRIVER_LOG") bytes"

if [ "$DRIVER_RC" -ne 0 ] || [ ! -s "$DRIVER_OUT" ]; then
  echo "FAIL: driver did not produce output"
  cat "$DRIVER_LOG"
  exit 1
fi

PASS=true
fail() { echo "FAIL: $1"; PASS=false; }

# Assertion 1: list_pro_features returned the locked V1 shape.
LIST_OK_KIND=$(jq -r '.list_pro_features.isError // false' "$DRIVER_OUT")
if [ "$LIST_OK_KIND" = "true" ]; then
  fail "axonflow_list_pro_features returned isError=true"
  cat "$DRIVER_OUT" | jq '.list_pro_features'
fi
DIFF_COUNT=$(jq -r '.list_pro_features.details.differentiators | length // 0' "$DRIVER_OUT" 2>/dev/null)
if [ "$DIFF_COUNT" != "5" ]; then
  fail "list_pro_features.differentiators length = $DIFF_COUNT (want 5)"
fi
PRICE=$(jq -r '.list_pro_features.details.pricing.price_usd // empty' "$DRIVER_OUT" 2>/dev/null)
if [ "$PRICE" != "9.99" ]; then
  fail "list_pro_features.pricing.price_usd = '$PRICE' (want 9.99)"
fi

# Assertion 2: callMCPTool directly returned an envelope on the first
# call (kind=envelope, with the locked V1 shape). This is the path the
# 4 proxy-tool wrappers go through; asserting it here proves the
# wire-level envelope detection works end-to-end.
RAW_KIND=$(jq -r '.get_cost_estimate_raw.kind // empty' "$DRIVER_OUT")
if [ "$RAW_KIND" != "envelope" ]; then
  fail "callMCPTool kind = '$RAW_KIND' (want 'envelope')"
fi
RAW_LIMIT_TYPE=$(jq -r '.get_cost_estimate_raw.envelope.limit_type // empty' "$DRIVER_OUT")
if [ "$RAW_LIMIT_TYPE" != "feature_pro_only" ]; then
  fail "envelope.limit_type = '$RAW_LIMIT_TYPE' (want 'feature_pro_only')"
fi
RAW_BUY=$(jq -r '.get_cost_estimate_raw.envelope.upgrade.buy_url // empty' "$DRIVER_OUT")
if [ "$RAW_BUY" != "https://buy.stripe.com/bJe28qbztcdVchjdkw8k800" ]; then
  fail "envelope.upgrade.buy_url = '$RAW_BUY' (want locked V1)"
fi
RAW_WORDING=$(jq -r '.get_cost_estimate_raw.envelope.upgrade.wording // empty' "$DRIVER_OUT")
if ! echo "$RAW_WORDING" | grep -qF "Pro feature"; then
  fail "envelope.upgrade.wording missing locked phrase 'Pro feature' (got: '$RAW_WORDING')"
fi

# Assertion 2b: the SECOND call (via the agent-tool execute() wrapper)
# saw the throttle file from the first call and short-circuited
# without a new network round-trip — proves the back-off gate works.
COST_IS_ERR=$(jq -r '.get_cost_estimate.isError // false' "$DRIVER_OUT")
if [ "$COST_IS_ERR" != "true" ]; then
  fail "agent-tool execute() did not return isError=true after envelope landed"
fi
COST_THROTTLED=$(jq -r '.get_cost_estimate.details.throttled // false' "$DRIVER_OUT")
if [ "$COST_THROTTLED" != "true" ]; then
  fail "agent-tool execute() did not honour throttle gate (details.throttled = '$COST_THROTTLED'; expected true)"
fi

# Assertion 3: the upgrade-prompt logger received the locked wording.
if ! grep -qF "Pro feature" "$DRIVER_LOG" && ! grep -qF "LLM cost pre-flight" "$DRIVER_LOG"; then
  fail "logger did not receive the V1 Pro-only wording (expected 'LLM cost pre-flight is a Pro feature')"
fi

# Assertion 4: throttle stamp was written by the envelope handler.
# Throttle stamp captured INSIDE the driver after test 2, before the
# driver clears it so tests 3+4 can round-trip. (At the end of the
# driver run the file is gone — that's intentional, not a failure.)
THROTTLE_STAMP=$(jq -r '.throttle_stamp_after_test2 // empty' "$DRIVER_OUT")
if [ -z "$THROTTLE_STAMP" ]; then
  fail "throttle-until file was never stamped after test 2 (envelope path didn't fire)"
else
  echo "$THROTTLE_STAMP" >"$EVIDENCE/throttle-until.txt"
  THROTTLE_EPOCH=$(echo "$THROTTLE_STAMP" | awk '{print $1}')
  NOW=$(date -u +%s)
  if [ -z "$THROTTLE_EPOCH" ] || ! [[ "$THROTTLE_EPOCH" =~ ^[0-9]+$ ]] || [ "$THROTTLE_EPOCH" -le "$NOW" ]; then
    fail "throttle deadline not in future (got '$THROTTLE_EPOCH'; now=$NOW)"
  fi
fi

# Test 3: request_approval (Free tier 1/7d rolling). First call should
# succeed (synthetic tenant has no prior HITL approvals). Server-side
# returns approval_id on success.
RA_KIND=$(jq -r '.request_approval_raw.kind // empty' "$DRIVER_OUT")
if [ "$RA_KIND" != "ok" ]; then
  fail "axonflow_request_approval kind=$RA_KIND (expected 'ok' for first Free-tier call)"
  jq '.request_approval_raw' "$DRIVER_OUT" 2>/dev/null
fi
RA_ID=$(jq -r '.request_approval_raw.result.approval_id // empty' "$DRIVER_OUT")
if [ -z "$RA_ID" ] || [ "$RA_ID" = "null" ]; then
  fail "axonflow_request_approval response missing approval_id"
fi

# Test 4: create_tenant_policy (Free tier 2 active max). First call
# should succeed.
CP_KIND=$(jq -r '.create_tenant_policy_raw.kind // empty' "$DRIVER_OUT")
if [ "$CP_KIND" != "ok" ]; then
  fail "axonflow_create_tenant_policy kind=$CP_KIND (expected 'ok' for first Free-tier call)"
  jq '.create_tenant_policy_raw' "$DRIVER_OUT" 2>/dev/null
fi
CP_ID=$(jq -r '.create_tenant_policy_raw.result.policy_id // empty' "$DRIVER_OUT")
if [ -z "$CP_ID" ] || [ "$CP_ID" = "null" ]; then
  fail "axonflow_create_tenant_policy response missing policy_id"
fi

# Test 5: get_tenant_id (local tool, no MCP round-trip).
GT_DETAILS_TYPE=$(jq -r '.get_tenant_id.details | type' "$DRIVER_OUT")
if [ "$GT_DETAILS_TYPE" != "object" ]; then
  fail "axonflow_get_tenant_id.execute() did not return ok-shaped details (type=$GT_DETAILS_TYPE)"
fi
GT_TENANT=$(jq -r '.get_tenant_id.details.tenant_id // empty' "$DRIVER_OUT")
if [ -z "$GT_TENANT" ] && [ -z "$(jq -r '.get_tenant_id.details.upgrade_url // empty' "$DRIVER_OUT")" ]; then
  fail "axonflow_get_tenant_id.execute() returned no tenant_id and no upgrade_url"
fi

{
  echo "OpenClaw V1 Plugin Pro proxy-tools runtime proof — $UTC_TS"
  echo "AGENT_URL=$AGENT_URL"
  echo "TENANT=$TENANT"
  echo
  echo "Tool 1 — axonflow_list_pro_features (Free pass):"
  echo "  differentiators: $DIFF_COUNT (want 5)"
  echo "  price_usd: $PRICE (want 9.99)"
  echo
  echo "Tool 2 — axonflow_get_cost_estimate (Free → envelope):"
  echo "  callMCPTool kind: $RAW_KIND (want envelope)"
  echo "  envelope.limit_type: $RAW_LIMIT_TYPE (want feature_pro_only)"
  echo "  envelope.buy_url: $RAW_BUY (want locked V1)"
  echo "  agent-tool throttle-gate honored: $COST_THROTTLED (want true)"
  echo "  throttle stamp deadline: $THROTTLE_EPOCH (want future epoch)"
  echo
  echo "Tool 3 — axonflow_request_approval (Free first call, expect ok):"
  echo "  callMCPTool kind: $RA_KIND (want ok)"
  echo "  approval_id: $RA_ID (want non-empty)"
  echo
  echo "Tool 4 — axonflow_create_tenant_policy (Free first call, expect ok):"
  echo "  callMCPTool kind: $CP_KIND (want ok)"
  echo "  policy_id: $CP_ID (want non-empty)"
  echo
  echo "Tool 5 — axonflow_get_tenant_id (local resolve):"
  echo "  details.tenant_id: $GT_TENANT (want any non-empty OR upgrade_url present)"
  echo
  echo "Result: $($PASS && echo PASS || echo FAIL)"
} | tee "$EVIDENCE/summary.txt"

if $PASS; then
  echo
  echo "PASS — OpenClaw proxies V1 Pro MCP tools and surfaces envelopes correctly"
  exit 0
else
  echo
  echo "FAIL — see $EVIDENCE/ for evidence"
  exit 1
fi
