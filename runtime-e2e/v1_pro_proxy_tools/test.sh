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
THROTTLE_FILE="$AXONFLOW_CACHE_DIR/throttle-until"
if [ ! -f "$THROTTLE_FILE" ]; then
  fail "throttle-until file not stamped at $THROTTLE_FILE"
else
  cp "$THROTTLE_FILE" "$EVIDENCE/throttle-until.txt"
fi

{
  echo "OpenClaw V1 Plugin Pro proxy-tools runtime proof — $UTC_TS"
  echo "AGENT_URL=$AGENT_URL"
  echo "TENANT=$TENANT"
  echo "list_pro_features differentiators: $DIFF_COUNT"
  echo "list_pro_features price_usd: $PRICE"
  echo "callMCPTool kind: $RAW_KIND"
  echo "envelope.limit_type: $RAW_LIMIT_TYPE"
  echo "envelope.buy_url: $RAW_BUY"
  echo "agent-tool throttle-gate honored: $COST_THROTTLED"
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
