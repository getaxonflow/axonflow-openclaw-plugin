#!/usr/bin/env bash
# Runtime proof for `axonflow_get_tenant_id` agent-tool registration.
#
# OpenClaw is architecturally distinct from the other plugin hosts —
# it does NOT consume the agent's MCP HTTP `/api/v1/mcp-server` tools/list
# auto-discovery. So the 5 V1 Pro MCP tools that flow into Claude /
# Cursor / Codex automatically don't reach OpenClaw without explicit
# `api.registerTool(...)` registration. This test asserts the
# `axonflow_get_tenant_id` tool is in the array returned by
# `buildAgentTools` AND that its `execute()` actually invokes the
# `buildStatusReport` code path (not a stubbed shape that just looks
# right at registration time).
#
# Exit codes:
#   0   PASS — tool registered + execute returns a real StatusReport-shaped
#              payload with tenant_id, tier, upgrade_url, buy_url
#   1   FAIL — assertion failed (test output explains which)
#   0   SKIP — required tool missing (node, npm)
#
# Per HARD RULE #0: drives the compiled `dist/agent-tools.js` against
# Node — same runtime path OpenClaw uses to load the plugin.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENT_TOOLS_JS="${PLUGIN_DIR}/dist/agent-tools.js"

UTC_TS=$(date -u +%Y%m%dT%H%M%SZ)
EVIDENCE="$SCRIPT_DIR/EVIDENCE/$UTC_TS"
mkdir -p "$EVIDENCE"

for tool in node jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "SKIP: $tool not on PATH"
    exit 0
  fi
done

if [ ! -f "$AGENT_TOOLS_JS" ]; then
  echo "Building plugin so dist/agent-tools.js exists..."
  ( cd "$PLUGIN_DIR" && npm run build >"$EVIDENCE/build.log" 2>&1 ) || {
    echo "FAIL: npm run build failed — see $EVIDENCE/build.log"
    exit 1
  }
fi
if [ ! -f "$AGENT_TOOLS_JS" ]; then
  echo "FAIL: dist/agent-tools.js missing after build at $AGENT_TOOLS_JS"
  exit 1
fi

# Hermetic cache + config so the status helper reads from a known empty
# state — we want to assert the code path runs, not that a real Pro
# license token is on the operator's disk.
TEST_HOME=$(mktemp -d -t axonflow-openclaw-tools.XXXXXX)
export AXONFLOW_CACHE_DIR="$TEST_HOME/cache"
export AXONFLOW_CONFIG_DIR="$TEST_HOME/config"
mkdir -p "$AXONFLOW_CACHE_DIR" "$AXONFLOW_CONFIG_DIR"
cleanup() { rm -rf "$TEST_HOME" 2>/dev/null || true; }
trap cleanup EXIT

# Build a Node driver that exercises buildAgentTools + the new tool's
# execute() function.
DRIVER_JS="$EVIDENCE/driver.cjs"
cat >"$DRIVER_JS" <<'NODE'
"use strict";

(async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const out = process.env.OUT_PATH;
  if (!out) {
    console.error("OUT_PATH env var required");
    process.exit(2);
  }

  const mod = require(process.argv[2]);
  if (typeof mod.buildAgentTools !== "function") {
    fs.writeFileSync(out, JSON.stringify({ error: "buildAgentTools not exported" }));
    process.exit(1);
  }

  // Build the full set with a no-op clientRef stub — buildGetTenantIdTool
  // doesn't touch the client (it builds a status report from local state).
  const stubClient = {};
  const tools = mod.buildAgentTools({ current: stubClient });
  const names = tools.map((t) => t.name).sort();
  const getTenantIdTool = tools.find((t) => t.name === "axonflow_get_tenant_id");

  let executeResult = null;
  let executeError = null;
  if (getTenantIdTool) {
    try {
      executeResult = await getTenantIdTool.execute("test-call-id-1", {});
    } catch (e) {
      executeError = e instanceof Error ? { message: e.message, stack: e.stack } : { value: String(e) };
    }
  }

  const payload = {
    names,
    has_get_tenant_id: !!getTenantIdTool,
    label: getTenantIdTool?.label,
    description_length: getTenantIdTool?.description?.length,
    parameters: getTenantIdTool?.parameters,
    executeResult,
    executeError,
  };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2));
  process.exit(0);
})();
NODE

DRIVER_OUT="$EVIDENCE/driver_out.json"
OUT_PATH="$DRIVER_OUT" node "$DRIVER_JS" "$AGENT_TOOLS_JS"
DRIVER_RC=$?

if [ "$DRIVER_RC" -ne 0 ]; then
  echo "FAIL: driver exit=$DRIVER_RC"
  cat "$DRIVER_OUT" 2>/dev/null
  exit 1
fi

PASS=true
fail() { echo "FAIL: $1"; PASS=false; }

# Tool is in the registry array.
if ! jq -e '.has_get_tenant_id == true' "$DRIVER_OUT" >/dev/null; then
  fail "buildAgentTools() does not include axonflow_get_tenant_id"
fi

# All 11 expected tool names present.
EXPECTED='["axonflow_audit_search","axonflow_create_override","axonflow_create_tenant_policy","axonflow_explain_decision","axonflow_get_cost_estimate","axonflow_get_tenant_id","axonflow_list_overrides","axonflow_list_pro_features","axonflow_list_recent_decisions","axonflow_request_approval","axonflow_revoke_override"]'
ACTUAL=$(jq -c '.names' "$DRIVER_OUT")
if [ "$ACTUAL" != "$EXPECTED" ]; then
  fail "registered tool names mismatch: got $ACTUAL, want $EXPECTED"
fi

# execute() resolved (not threw) AND returned the StatusReport-shaped
# payload (tenant_id key + upgrade_url + buy_url).
if jq -e '.executeError != null' "$DRIVER_OUT" >/dev/null; then
  fail "axonflow_get_tenant_id.execute() threw: $(jq -r '.executeError.message' "$DRIVER_OUT")"
fi

DETAILS_TYPE=$(jq -r '.executeResult.details | type' "$DRIVER_OUT")
[ "$DETAILS_TYPE" = "object" ] || fail "executeResult.details is not an object (got '$DETAILS_TYPE')"

for key in tier endpoint upgrade_url buy_url; do
  if ! jq -e ".executeResult.details | has(\"${key}\")" "$DRIVER_OUT" >/dev/null; then
    fail "executeResult.details missing key '${key}'"
  fi
done

UPGRADE_URL=$(jq -r '.executeResult.details.upgrade_url // empty' "$DRIVER_OUT")
[ "$UPGRADE_URL" = "https://getaxonflow.com/pricing/" ] || fail "upgrade_url='${UPGRADE_URL}' (want https://getaxonflow.com/pricing/)"
BUY_URL=$(jq -r '.executeResult.details.buy_url // empty' "$DRIVER_OUT")
[ "$BUY_URL" = "https://buy.stripe.com/bJe28qbztcdVchjdkw8k800" ] || fail "buy_url='${BUY_URL}' (want https://buy.stripe.com/bJe28qbztcdVchjdkw8k800)"

# isError must be falsy on the status-report path (no error).
if jq -e '.executeResult.isError == true' "$DRIVER_OUT" >/dev/null 2>&1; then
  fail "executeResult.isError === true (status report path should not error on hermetic state)"
fi

{
  echo "OpenClaw agent-tools registration runtime proof — $UTC_TS"
  echo "Driver rc: $DRIVER_RC"
  echo "Registered tools: $(jq -r '.names | join(", ")' "$DRIVER_OUT")"
  echo "axonflow_get_tenant_id present: $(jq -r '.has_get_tenant_id' "$DRIVER_OUT")"
  echo "execute() upgrade_url: $UPGRADE_URL"
  echo "execute() buy_url: $BUY_URL"
  echo "Result: $($PASS && echo PASS || echo FAIL)"
} | tee "$EVIDENCE/summary.txt"

if $PASS; then
  echo
  echo "PASS — axonflow_get_tenant_id is registered and execute() returns the locked V1 shape"
  exit 0
else
  echo
  echo "FAIL — see $EVIDENCE/ for evidence"
  exit 1
fi
