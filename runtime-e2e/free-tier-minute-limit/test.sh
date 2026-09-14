#!/usr/bin/env bash
# free-tier-minute-limit: runtime E2E for the OpenClaw plugin's AxonFlow agent
# tools over the Community SaaS Free per-minute limit.
#
# Drives the plugin's REAL compiled client (dist/axonflow-client.js: callMCPTool,
# the helper behind the plugin's AxonFlow agent tools) against a REAL local
# AxonFlow stack in Community SaaS mode. A freshly registered Free tenant is
# pushed past its per-minute limit by the client's own MCP calls: no mocks, no
# stubs, no recorded responses. See README.md.
#
# Usage: AXONFLOW_ENDPOINT=http://localhost:8080 bash runtime-e2e/free-tier-minute-limit/test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

ENDPOINT="${AXONFLOW_ENDPOINT:-http://localhost:8080}"
MAX_CALLS="${AXONFLOW_E2E_CAP_MAX_CALLS:-60}"
EVIDENCE="${AXONFLOW_E2E_EVIDENCE_DIR:-$(mktemp -d -t free-tier-minute-limit.XXXXXX)}"
PROMPT_LINE="[AxonFlow] Upgrade: "

PASS=0
FAIL=0
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }

echo "=== Free-tier minute limit (OpenClaw agent tools) ==="
echo "Endpoint: $ENDPOINT"
echo "Evidence: $EVIDENCE"
mkdir -p "$EVIDENCE" || exit 1

for tool in node curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "SKIP: $tool not on PATH"
    exit 0
  fi
done
if ! curl -sSf -o /dev/null --max-time 5 "$ENDPOINT/health"; then
  echo "SKIP: AxonFlow stack not reachable at $ENDPOINT"
  exit 0
fi

if [ ! -f "$PLUGIN_DIR/dist/axonflow-client.js" ]; then
  echo "Building the plugin so dist/axonflow-client.js exists..."
  if ! (cd "$PLUGIN_DIR" && npm run build > "$EVIDENCE/build.log" 2>&1); then
    echo "FAIL: npm run build failed (see $EVIDENCE/build.log)"
    exit 1
  fi
fi

# A fresh Free tenant through the Community SaaS registration route, which
# exists only in community-saas mode. The secret is a credential: it reaches
# the driver through its environment only and is never printed or written.
REG_LABEL="free-tier-minute-limit-openclaw-$(date +%s)-$RANDOM"
REG=$(curl -s -w '\n%{http_code}' -X POST "$ENDPOINT/api/v1/register" \
  -H 'Content-Type: application/json' \
  -d "{\"label\":\"$REG_LABEL\",\"email\":\"$REG_LABEL@axonflow-test.invalid\"}")
REG_CODE="${REG##*$'\n'}"
REG_JSON="${REG%$'\n'*}"
if [ "$REG_CODE" = "404" ]; then
  echo "SKIP: /api/v1/register answered 404, so this stack is not in community-saas mode"
  echo "      (docker compose -f docker-compose.yml -f docker-compose.community-saas.yml up -d)"
  exit 0
fi
TENANT_ID=$(printf '%s' "$REG_JSON" | jq -r '.tenant_id // empty' 2>/dev/null)
SECRET=$(printf '%s' "$REG_JSON" | jq -r '.secret // empty' 2>/dev/null)
if [ -z "$TENANT_ID" ] || [ -z "$SECRET" ]; then
  echo "FAIL: registration answered HTTP $REG_CODE without a tenant_id and secret"
  echo "  body: $(printf '%s' "$REG_JSON" | jq -c 'del(.secret?)' 2>/dev/null | cut -c1-300)"
  exit 1
fi
unset REG REG_JSON
pass "registered Free tenant $TENANT_ID (HTTP $REG_CODE; the secret is not printed)"

# The driver calls the plugin's own compiled client, exactly as its agent
# tools do, until the limit answers; then once more while the back-off holds.
DRIVER="$EVIDENCE/driver.cjs"
OUT="$EVIDENCE/result.json"
cat > "$DRIVER" <<'NODE'
"use strict";

(async () => {
  const fs = require("node:fs");
  const { AxonFlowClient } = require(process.env.PLUGIN_DIR + "/dist/axonflow-client.js");
  const { isThrottleActive } = require(process.env.PLUGIN_DIR + "/dist/upgrade-prompt.js");

  const client = new AxonFlowClient({
    endpoint: process.env.E2E_ENDPOINT,
    clientId: process.env.E2E_TENANT,
    clientSecret: process.env.E2E_SECRET,
    requestTimeoutMs: 15000,
  });
  const prompts = [];
  client.setUpgradePromptLogger({
    info: (m) => prompts.push(m),
    warn: (m) => prompts.push(m),
    error: (m) => prompts.push(m),
  });

  const max = Number(process.env.E2E_MAX_CALLS || "60");
  const calls = [];
  let over = null;
  for (let i = 1; i <= max; i++) {
    const res = await client.callMCPTool("axonflow_list_pro_features", {});
    const row = { call: i, kind: res.kind };
    if (res.kind === "envelope") {
      row.limit_type = res.envelope.limit_type;
      row.window = res.envelope.window ?? null;
      row.resets_at = res.envelope.resets_at ?? null;
    }
    if (res.kind === "error") {
      row.message = res.message;
      row.status = res.status ?? null;
    }
    calls.push(row);
    if (res.kind !== "ok") {
      over = res;
      break;
    }
  }
  const throttleActive = over ? isThrottleActive() : false;
  const next = over ? await client.callMCPTool("axonflow_list_pro_features", {}) : null;
  fs.writeFileSync(process.env.E2E_OUT, JSON.stringify({
    calls,
    prompts,
    throttleActive,
    nextKind: next ? next.kind : null,
  }, null, 2));
})().catch((e) => {
  console.error("driver error:", (e && e.stack) || e);
  process.exit(3);
});
NODE

mkdir -p "$EVIDENCE/cache" || exit 1
env -u AXONFLOW_USER_TOKEN -u AXONFLOW_LICENSE_TOKEN -u AXONFLOW_PEP_AUDIENCE \
  PLUGIN_DIR="$PLUGIN_DIR" E2E_ENDPOINT="$ENDPOINT" E2E_TENANT="$TENANT_ID" E2E_SECRET="$SECRET" \
  E2E_MAX_CALLS="$MAX_CALLS" E2E_OUT="$OUT" AXONFLOW_CACHE_DIR="$EVIDENCE/cache" \
  AXONFLOW_TELEMETRY=off \
  node "$DRIVER" > "$EVIDENCE/driver.stdout" 2> "$EVIDENCE/driver.stderr"
DRIVER_RC=$?
unset SECRET
if [ "$DRIVER_RC" -ne 0 ] || [ ! -f "$OUT" ]; then
  echo "FAIL: the driver exited $DRIVER_RC without a result (see $EVIDENCE/driver.stderr)"
  head -5 "$EVIDENCE/driver.stderr"
  exit 1
fi

echo ""
OK_CALLS=$(jq '[.calls[] | select(.kind == "ok")] | length' "$OUT")
LAST_KIND=$(jq -r '.calls[-1].kind' "$OUT")
LAST_CALL=$(jq -r '.calls[-1].call' "$OUT")
if [ "$OK_CALLS" -ge 1 ]; then
  pass "$OK_CALLS tool call(s) returned kind ok under the limit"
else
  fail "the first tool call was already refused (kind $LAST_KIND)"
fi
if [ "$LAST_KIND" = "ok" ]; then
  fail "all $MAX_CALLS tool calls returned kind ok: the limit never answered"
elif [ "$LAST_KIND" = "envelope" ]; then
  pass "call $LAST_CALL over the limit returned kind envelope, not a successful tool result"
else
  fail "call $LAST_CALL over the limit returned kind $LAST_KIND, not the envelope: $(jq -c '.calls[-1]' "$OUT")"
fi
echo "OBSERVED: $(jq -c '.calls[-1] | {limit_type, window, resets_at}' "$OUT")"
if jq -e --arg p "$PROMPT_LINE" '[.prompts[] | select(startswith($p))] | length > 0' "$OUT" >/dev/null; then
  pass "the upgrade prompt was shown: $(jq -r --arg p "$PROMPT_LINE" '[.prompts[] | select(startswith($p) | not)][0] // ""' "$OUT")"
else
  fail "no upgrade prompt ($PROMPT_LINE...) reached the plugin's logger"
fi
if [ "$(jq -r '.throttleActive' "$OUT")" = "true" ]; then
  pass "the back-off is stamped in $EVIDENCE/cache"
else
  fail "no active back-off after the limit answered"
fi
NEXT_KIND=$(jq -r '.nextKind' "$OUT")
if [ "$NEXT_KIND" = "throttled" ]; then
  pass "the next call was answered from the back-off (kind throttled)"
else
  fail "the next call returned kind $NEXT_KIND, not throttled"
fi

echo ""
echo "=== Free-tier minute limit (OpenClaw agent tools): $PASS passed, $FAIL failed ==="
echo "Evidence: $EVIDENCE"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
