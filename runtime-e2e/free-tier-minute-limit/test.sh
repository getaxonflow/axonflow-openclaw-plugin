#!/usr/bin/env bash
# free-tier-minute-limit: runtime E2E for the OpenClaw plugin's AxonFlow agent
# tools over the Community SaaS Free per-minute limit, on both of its paths.
#
# Drives the plugin's REAL compiled client (dist/axonflow-client.js: callMCPTool,
# the helper behind the plugin's AxonFlow agent tools) against a REAL local
# AxonFlow stack in Community SaaS mode. callMCPTool runs initialize and then
# tools/call, so the limit can answer on either request:
#   - the tier-check path: tools/call is answered with the limit's envelope;
#   - the pre-credential path: initialize itself is refused with a 429.
# A freshly registered Free tenant is pushed past the limit by the client's own
# MCP calls. No mocks, no stubs, no recorded responses: a pass-through recorder
# only notes each real response's method, status and envelope. See README.md.
#
# Usage: AXONFLOW_ENDPOINT=http://localhost:8080 bash runtime-e2e/free-tier-minute-limit/test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

ENDPOINT="${AXONFLOW_ENDPOINT:-http://localhost:8080}"
MAX_CALLS="${AXONFLOW_E2E_CAP_MAX_CALLS:-60}"
PRECRED_MAX_CALLS="${AXONFLOW_E2E_PRECRED_MAX_CALLS:-400}"
BATCH="${AXONFLOW_E2E_BATCH:-10}"
EVIDENCE="${AXONFLOW_E2E_EVIDENCE_DIR:-$(mktemp -d -t free-tier-minute-limit.XXXXXX)}"

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

# The driver calls the plugin's own compiled client, exactly as its agent tools
# do. Phase 1 calls with one back-off cache until the limit answers (the
# tier-check path), then once more while the back-off holds. Phase 2 sends
# concurrent batches, each call pointed at a fresh cache directory so the local
# back-off does not answer, until initialize itself is refused. Those calls share
# one process environment, and the plugin reads AXONFLOW_CACHE_DIR after its
# awaits, so a batch's calls are NOT isolated from each other: the leg asserts
# only their kinds. It then sends ONE isolated probe, alone, with its own cache
# directory: the pre-credential path's prompt and back-off are asserted on it.
DRIVER="$EVIDENCE/driver.cjs"
OUT="$EVIDENCE/result.json"
cat > "$DRIVER" <<'NODE'
"use strict";

(async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { AsyncLocalStorage } = require("node:async_hooks");
  const { AxonFlowClient } = require(process.env.PLUGIN_DIR + "/dist/axonflow-client.js");
  const { isThrottleActive } = require(process.env.PLUGIN_DIR + "/dist/upgrade-prompt.js");

  // A pass-through recorder: every request still goes to the real stack and
  // every real response goes back to the client untouched; this only notes the
  // request's JSON-RPC method, the status and whether the body is the limit's
  // envelope, keyed by the tool call that made it.
  const als = new AsyncLocalStorage();
  const wire = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const res = await realFetch(url, init);
    const call = als.getStore();
    if (call !== undefined) {
      let method = null;
      try { method = JSON.parse((init && init.body) || "{}").method || null; } catch { /* not JSON */ }
      let limitType = null;
      try {
        const body = JSON.parse(await res.clone().text());
        const inner = body && body.result && Array.isArray(body.result.content) && body.result.content[0]
          ? body.result.content[0].text : null;
        const env = body && typeof body.limit_type === "string" ? body : (typeof inner === "string" ? JSON.parse(inner) : null);
        limitType = env && typeof env.limit_type === "string" ? env.limit_type : null;
      } catch { /* not an envelope */ }
      (wire[call] = wire[call] || []).push({ method, status: res.status, retryAfter: res.headers.get("retry-after"), limitType });
    }
    return res;
  };

  const client = new AxonFlowClient({
    endpoint: process.env.E2E_ENDPOINT,
    clientId: process.env.E2E_TENANT,
    clientSecret: process.env.E2E_SECRET,
    requestTimeoutMs: 15000,
  });
  const prompts = [];
  const sink = (m) => prompts.push({ call: als.getStore() ?? null, msg: m });
  client.setUpgradePromptLogger({ info: sink, warn: sink, error: sink });

  const row = (phase, call, res) => {
    const w = wire[call] || [];
    const pick = (m) => {
      const x = w.find((e) => e.method === m);
      return x ? { status: x.status, retryAfter: x.retryAfter, limitType: x.limitType } : null;
    };
    const init = pick("initialize");
    const toolsCall = pick("tools/call");
    const r = {
      phase,
      call,
      kind: res.kind,
      initialize: init,
      toolsCall,
      envelopeOn: init && init.limitType ? "initialize" : (toolsCall && toolsCall.limitType ? "tools/call" : null),
      prompt: prompts.some((p) => p.call === call && p.msg.startsWith("[AxonFlow] Upgrade: ")),
    };
    if (res.kind === "envelope") r.limitType = res.envelope.limit_type;
    if (res.kind === "error") { r.message = res.message; r.status = res.status ?? null; }
    return r;
  };
  const invoke = (call) => als.run(call, () => client.callMCPTool("axonflow_list_pro_features", {}));

  const results = [];
  let n = 0;
  let over = null;
  const max1 = Number(process.env.E2E_MAX_CALLS || "60");
  for (let i = 1; i <= max1 && !over; i++) {
    const call = ++n;
    const r = row(1, call, await invoke(call));
    results.push(r);
    if (r.kind !== "ok") over = r;
  }
  // An agent tool's limit stamps the agent-tool back-off (tool-throttle-until),
  // never the governed one (#196).
  const throttleActive = over ? isThrottleActive(undefined, undefined, { file: "tool-throttle-until" }) : false;
  let nextKind = null;
  if (over) {
    const call = ++n;
    const r = row("held", call, await invoke(call));
    results.push(r);
    nextKind = r.kind;
  }

  const baseCache = process.env.AXONFLOW_CACHE_DIR;
  const max2 = Number(process.env.E2E_PRECRED_MAX_CALLS || "400");
  const batch = Number(process.env.E2E_BATCH || "10");
  let sent2 = 0;
  let probe = null;
  // Climb the counter with concurrent batches until initialize itself is refused,
  // then send ONE probe alone with its own cache directory. If the limit's minute
  // rolled over before the probe landed (its initialize succeeded), climb again.
  for (let attempt = 1; attempt <= 3 && over && sent2 < max2; attempt++) {
    let refused = null;
    while (!refused && sent2 < max2) {
      const pending = [];
      for (let j = 0; j < batch && sent2 < max2; j++, sent2++) {
        const call = ++n;
        process.env.AXONFLOW_CACHE_DIR = path.join(baseCache, "p2-" + call);
        pending.push(invoke(call).then((res) => row(2, call, res)));
      }
      const rows = await Promise.all(pending);
      results.push(...rows);
      refused = rows.find((r) => r.initialize && r.initialize.status >= 400) || null;
    }
    if (!refused) break;
    const call = ++n;
    const dir = path.join(baseCache, "probe-" + call);
    process.env.AXONFLOW_CACHE_DIR = dir;
    const r = row("probe", call, await invoke(call));
    r.attempt = attempt;
    r.cacheDir = path.basename(dir);
    r.throttleStamped = fs.existsSync(path.join(dir, "tool-throttle-until"));
    results.push(r);
    probe = r;
    if (r.initialize && r.initialize.status >= 400) break;
  }
  process.env.AXONFLOW_CACHE_DIR = baseCache;

  fs.writeFileSync(process.env.E2E_OUT, JSON.stringify({ results, throttleActive, nextKind, phase2Calls: sent2 }, null, 2));
})().catch((e) => {
  console.error("driver error:", (e && e.stack) || e);
  process.exit(3);
});
NODE

mkdir -p "$EVIDENCE/cache" || exit 1
env -u AXONFLOW_USER_TOKEN -u AXONFLOW_LICENSE_TOKEN -u AXONFLOW_PEP_AUDIENCE \
  PLUGIN_DIR="$PLUGIN_DIR" E2E_ENDPOINT="$ENDPOINT" E2E_TENANT="$TENANT_ID" E2E_SECRET="$SECRET" \
  E2E_MAX_CALLS="$MAX_CALLS" E2E_PRECRED_MAX_CALLS="$PRECRED_MAX_CALLS" E2E_BATCH="$BATCH" \
  E2E_OUT="$OUT" AXONFLOW_CACHE_DIR="$EVIDENCE/cache" AXONFLOW_TELEMETRY=off \
  node "$DRIVER" > "$EVIDENCE/driver.stdout" 2> "$EVIDENCE/driver.stderr"
DRIVER_RC=$?
unset SECRET
if [ "$DRIVER_RC" -ne 0 ] || [ ! -f "$OUT" ]; then
  echo "FAIL: the driver exited $DRIVER_RC without a result (see $EVIDENCE/driver.stderr)"
  head -5 "$EVIDENCE/driver.stderr"
  exit 1
fi

echo ""
echo "--- under the limit ---"
P1_OK=$(jq '[.results[] | select(.phase == 1 and .kind == "ok")] | length' "$OUT")
if [ "$P1_OK" -ge 1 ]; then
  pass "$P1_OK tool call(s) returned kind ok under the limit"
else
  fail "the first tool call was already refused: $(jq -c '.results[0]' "$OUT")"
fi

echo ""
echo "--- every answer that carried the limit's envelope ---"
ENV_ROWS=$(jq '[.results[] | select(.envelopeOn != null)] | length' "$OUT")
BAD=$(jq -c '[.results[] | select(.envelopeOn != null and .kind != "envelope") | {call, envelopeOn, kind, message}]' "$OUT")
if [ "$ENV_ROWS" -ge 1 ] && [ "$BAD" = "[]" ]; then
  pass "all $ENV_ROWS answers that carried the limit's envelope came back as kind envelope: never ok, never a bare error"
else
  fail "answers carrying the limit's envelope that did not come back as kind envelope ($ENV_ROWS carried one): $BAD"
fi
if [ "$(jq '[.results[] | select(.kind == "ok" and .envelopeOn != null)] | length' "$OUT")" -eq 0 ]; then
  pass "no call returned kind ok on an answer that carried the limit's envelope"
else
  fail "a call returned kind ok on an answer that carried the limit's envelope (the silent-success defect)"
fi

echo ""
echo "--- the tier-check path (tools/call answered with the limit) ---"
TIER=$(jq -c '[.results[] | select(.envelopeOn == "tools/call")][0] // empty' "$OUT")
if [ -z "$TIER" ]; then
  fail "tier-check path: no tools/call was answered with the limit's envelope"
else
  echo "OBSERVED: tier-check path: $(jq -c '{call, toolsCall, kind, limitType}' <<< "$TIER")"
  if [ "$(jq -r '.kind' <<< "$TIER")" = "envelope" ] && [ "$(jq -r '.prompt' <<< "$TIER")" = "true" ]; then
    pass "tier-check path: call $(jq -r '.call' <<< "$TIER") returned kind envelope (limit_type $(jq -r '.limitType' <<< "$TIER")), with the upgrade prompt shown"
  else
    fail "tier-check path: call $(jq -r '.call' <<< "$TIER") returned kind $(jq -r '.kind' <<< "$TIER"), prompt shown: $(jq -r '.prompt' <<< "$TIER")"
  fi
fi
if [ "$(jq -r '.throttleActive' "$OUT")" = "true" ]; then
  pass "the back-off is stamped after the limit answered"
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
echo "--- the pre-credential path (initialize itself refused; asserted on the isolated probe) ---"
PC=$(jq -c '[.results[] | select(.phase == "probe")] | last // empty' "$OUT")
if [ -z "$PC" ]; then
  fail "pre-credential path: initialize was never refused within $(jq -r '.phase2Calls' "$OUT") phase-2 calls, so no isolated probe was sent"
elif [ "$(jq -r '.initialize.status // 0' <<< "$PC")" -lt 400 ]; then
  fail "pre-credential path: the isolated probe's initialize was not refused (HTTP $(jq -r '.initialize.status // "none"' <<< "$PC"), attempt $(jq -r '.attempt' <<< "$PC"))"
else
  PC_CALL=$(jq -r '.call' <<< "$PC")
  PC_KIND=$(jq -r '.kind' <<< "$PC")
  PC_STATUS=$(jq -r '.initialize.status' <<< "$PC")
  echo "OBSERVED: pre-credential path: $(jq -c '{call, initialize, kind, message, limitType}' <<< "$PC")"
  if [ "$PC_KIND" = "ok" ]; then
    fail "pre-credential path: call $PC_CALL returned kind ok although initialize answered HTTP $PC_STATUS"
  elif [ "$(jq -r '.envelopeOn' <<< "$PC")" = "initialize" ]; then
    if [ "$PC_KIND" = "envelope" ] && [ "$(jq -r '.prompt' <<< "$PC")" = "true" ] && [ "$(jq -r '.throttleStamped' <<< "$PC")" = "true" ]; then
      pass "pre-credential path: the isolated probe's initialize answered HTTP $PC_STATUS with the limit's envelope, and call $PC_CALL returned kind envelope (limit_type $(jq -r '.limitType' <<< "$PC")) with the upgrade prompt and its own back-off stamped"
    else
      fail "pre-credential path: the isolated probe's initialize carried the envelope, but call $PC_CALL returned kind $PC_KIND, prompt shown: $(jq -r '.prompt' <<< "$PC"), back-off stamped: $(jq -r '.throttleStamped' <<< "$PC")"
    fi
  else
    pass "pre-credential path: initialize answered HTTP $PC_STATUS, and call $PC_CALL was refused (kind $PC_KIND), not a successful tool result"
    echo "OBSERVED: that refusal carried no upgrade envelope, so there was no prompt to show; the platform side is getaxonflow/axonflow-enterprise#4261, which answers it with HTTP 429 and the per_minute envelope"
  fi
fi

echo ""
echo "=== Free-tier minute limit (OpenClaw agent tools): $PASS passed, $FAIL failed ==="
echo "Evidence: $EVIDENCE"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
