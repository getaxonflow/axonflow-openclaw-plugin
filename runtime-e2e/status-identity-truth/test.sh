#!/usr/bin/env bash
# OpenClaw runtime E2E: status/identity truth for self-hosted installs (#167).
#
# Drives the REAL plugin through the REAL OpenClaw host (`openclaw plugins
# install`) and the REAL status bin, and proves the surfaces agree with the
# governance runtime:
#
#   S1. pluginConfig.endpoint set to a local SENTINEL, no AXONFLOW_ENDPOINT
#       in the environment, and a Community-SaaS registration file on disk
#       carrying a cs_ tenant. The init canary reports the SENTINEL with
#       mode=self-hosted; the status CLI reports the SAME endpoint, mode
#       self-hosted, and the configured clientId — NOT the cs_ tenant sitting
#       right next to it. Through v2.8.4 this leg fails: the CLI is a
#       standalone bin with no pluginConfig context, so it printed
#       https://try.getaxonflow.com and the cached cs_ id.
#
#   S2. VACUITY CONTROL. Delete the runtime-state record and re-run the same
#       CLI against the same config: it must fall back to the Community-SaaS
#       default — i.e. reproduce the pre-fix wrong answer. This proves S1 is
#       carried by the mechanism under test and not by ambient state.
#
#   S3. `axonflow_get_tenant_id` through a real agent dispatch reports the
#       self-hosted endpoint + identity — with the runtime-state record made
#       UNREADABLE for the turn, so only the live in-process config can
#       produce the right answer and a reverted in-process path would fall
#       back to the Community-SaaS default.
#
#   S4. AXONFLOW_ENDPOINT in the CLI's own environment still wins over the
#       recorded pluginConfig — a persisted value can never outrank the
#       reader's live environment.
#
#   S5. `openclaw plugins doctor` reports zero diagnostics for the plugin.
#
#   S6. The OTHER configuration channel: the runtime is loaded with
#       AXONFLOW_ENDPOINT set and no pluginConfig at all, then the CLI is run
#       from a shell that does NOT export it. Round-1 hostile review of this
#       change found that a pluginConfig-only record left #167 fully intact
#       here. Also asserts that the reader's own AXONFLOW_ENDPOINT still wins,
#       with the endpoint the runtime is still on reported alongside it.
#
# Env hygiene (#2937 class): AXONFLOW_ENDPOINT / AXONFLOW_CONFIG_DIR are
# commonly exported by the e2e driver shell, so every openclaw and node
# invocation below pins or clears them explicitly with `env VAR=` / `env -u
# VAR`, scoped to the single command.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not on PATH"; exit 0; }

OPENCLAW_CONFIG_FILE="${OPENCLAW_CONFIG_FILE:-$HOME/.openclaw/openclaw.json}"
if [ ! -f "$OPENCLAW_CONFIG_FILE" ]; then
  echo "SKIP: openclaw config not found at $OPENCLAW_CONFIG_FILE"
  exit 0
fi

SENTINEL_CLIENT_ID="e2e-selfhosted-tenant"
CACHED_SAAS_TENANT="cs_e2e_cached_saas_tenant"

CONFIG_BACKUP="$(mktemp -t axonflow-status-truth-cfgbak.XXXXXX)"
cp "$OPENCLAW_CONFIG_FILE" "$CONFIG_BACKUP"

# Isolated AxonFlow config dir: the runtime-state record and the registration
# file both live here, and we must not read or clobber the developer's real
# credentials.
AXONFLOW_STATE_DIR="$(mktemp -d -t axonflow-status-truth-state.XXXXXX)"
chmod 700 "$AXONFLOW_STATE_DIR"

SENTINEL_LOG="$(mktemp -t axonflow-status-truth-sentinel.XXXXXX)"
SENTINEL_PID=""

cleanup() {
  if [ -f "$CONFIG_BACKUP" ]; then
    cp "$CONFIG_BACKUP" "$OPENCLAW_CONFIG_FILE"
    rm -f "$CONFIG_BACKUP"
  fi
  [ -n "$SENTINEL_PID" ] && kill "$SENTINEL_PID" 2>/dev/null
  rm -rf "$AXONFLOW_STATE_DIR"
  rm -f "$SENTINEL_LOG"
}
trap cleanup EXIT INT TERM HUP

# Minimal HTTP listener: records "METHOD PATH" per request and answers 200 {}.
# The plugin's startup /health probe only needs a 2xx.
start_listener() {
  local log="$1"
  LISTENER_LOG="$log" python3 - <<'PY' &
import http.server, json, os, threading

log_path = os.environ["LISTENER_LOG"]
lock = threading.Lock()

class Handler(http.server.BaseHTTPRequestHandler):
    def _record(self):
        with lock, open(log_path, "a") as f:
            f.write(f"{self.command} {self.path}\n")
        body = json.dumps({"status": "ok", "allowed": True, "policies_evaluated": 0}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    do_GET = _record
    do_POST = _record
    do_HEAD = _record
    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
PY
}

SENTINEL_PORT_FILE="$(mktemp -t axonflow-status-truth-port.XXXXXX)"
start_listener "$SENTINEL_LOG" >"$SENTINEL_PORT_FILE"
SENTINEL_PID=$!
for _ in $(seq 1 20); do
  [ -s "$SENTINEL_PORT_FILE" ] && break
  sleep 0.25
done
SENTINEL_PORT="$(cat "$SENTINEL_PORT_FILE")"; rm -f "$SENTINEL_PORT_FILE"
if [ -z "$SENTINEL_PORT" ]; then
  # #172: this is NOT an environment gate — python3 presence was already
  # asserted above, so reaching this branch means the harness itself
  # malfunctioned. Reporting green here would mean the suite asserted
  # nothing. Same shape as failopen-notice's control-listener failure.
  echo "FAIL: could not start the local sentinel listener — harness malfunction (python3 is present), not an environment gap"
  exit 1
fi
SENTINEL_URL="http://127.0.0.1:$SENTINEL_PORT"
echo "--- sentinel=$SENTINEL_URL state_dir=$AXONFLOW_STATE_DIR ---"

# Seed the COMPETING WRONG ANSWER: a Community-SaaS registration file with a
# cs_ tenant and the SaaS endpoint. Everything below must ignore it, because
# this install is self-hosted. Without this seed the assertions would be
# vacuous — the wrong answer has to be available for "not chosen" to mean
# anything.
cat >"$AXONFLOW_STATE_DIR/try-registration.json" <<JSON
{"tenant_id":"$CACHED_SAAS_TENANT","secret":"synth-tok-e2e","expires_at":"2030-01-01T00:00:00Z","endpoint":"https://try.getaxonflow.com"}
JSON
chmod 600 "$AXONFLOW_STATE_DIR/try-registration.json"

plugin_config_patch() {
  CONFIG_FILE="$OPENCLAW_CONFIG_FILE" SET_KEYS="$1" DEL_KEYS="${2:-}" python3 - <<'PY'
import json, os
path = os.environ["CONFIG_FILE"]
cfg = json.load(open(path))
entry = cfg.setdefault("plugins", {}).setdefault("entries", {}).setdefault("axonflow-governance", {})
block = entry.setdefault("config", {})
sets = json.loads(os.environ["SET_KEYS"]) if os.environ["SET_KEYS"] else {}
block.update(sets)
for k in os.environ["DEL_KEYS"].split():
    block.pop(k, None)
json.dump(cfg, open(path, "w"), indent=2)
PY
}

errors=0
fail() { echo "FAIL: $1"; errors=$((errors + 1)); }
pass() { echo "PASS: $1"; }

STATUS_BIN="$PLUGIN_DIR/bin/axonflow-openclaw-status.mjs"
RUNTIME_STATE_FILE="$AXONFLOW_STATE_DIR/openclaw-plugin-runtime-state.json"

# ---------------------------------------------------------------------------
# S1 — pluginConfig endpoint + identity reach the standalone status CLI
# ---------------------------------------------------------------------------
echo "--- S1: status CLI reports the self-hosted endpoint + identity ---"
plugin_config_patch \
  "{\"endpoint\": \"$SENTINEL_URL\", \"clientId\": \"$SENTINEL_CLIENT_ID\", \"clientSecret\": \"synth-tok-e2e-secret\"}" ""

echo "--- Building + installing local OpenClaw plugin ---"
( cd "$PLUGIN_DIR" && npm run --silent build ) >/dev/null 2>&1 || { echo "FAIL: plugin build failed"; exit 1; }
INSTALL_OUT="$( cd "$PLUGIN_DIR" && env -u AXONFLOW_ENDPOINT AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
    openclaw plugins install --force --dangerously-force-unsafe-install . 2>&1 )"

if printf '%s' "$INSTALL_OUT" | grep -qF "[AxonFlow] Connected to AxonFlow at $SENTINEL_URL (mode=self-hosted)"; then
  pass "init canary reports the pluginConfig endpoint with mode=self-hosted"
else
  fail "init canary does not report the pluginConfig endpoint"
  printf '%s\n' "$INSTALL_OUT" | grep -F "[AxonFlow]" | head -3 | sed 's/^/      /'
fi

if [ -f "$RUNTIME_STATE_FILE" ]; then
  pass "plugin load wrote the runtime-state record"
  STATE_MODE=$(python3 -c "import os,stat;print(oct(stat.S_IMODE(os.stat('$RUNTIME_STATE_FILE').st_mode)))")
  if [ "$STATE_MODE" = "0o600" ]; then
    pass "runtime-state record is 0600"
  else
    fail "runtime-state record has mode $STATE_MODE (expected 0o600)"
  fi
  if grep -q "synth-tok-e2e-secret" "$RUNTIME_STATE_FILE"; then
    fail "runtime-state record contains the clientSecret"
  else
    pass "runtime-state record contains no credential"
  fi
else
  fail "plugin load did not write $RUNTIME_STATE_FILE"
fi

STATUS_JSON="$( env -u AXONFLOW_ENDPOINT AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
    node "$STATUS_BIN" --json 2>/dev/null )"
echo "$STATUS_JSON" | sed 's/^/      /'

CLI_ENDPOINT=$(printf '%s' "$STATUS_JSON" | jq -r '.endpoint // empty')
CLI_CLIENT=$(printf '%s' "$STATUS_JSON" | jq -r '.client_id // empty')
CLI_MODE=$(printf '%s' "$STATUS_JSON" | jq -r '.mode // empty')

if [ "$CLI_ENDPOINT" = "$SENTINEL_URL" ]; then
  pass "status CLI endpoint == the endpoint the runtime resolved"
else
  fail "status CLI reported endpoint '$CLI_ENDPOINT' (expected $SENTINEL_URL)"
fi
if [ "$CLI_MODE" = "self-hosted" ]; then
  pass "status CLI mode == self-hosted"
else
  fail "status CLI reported mode '$CLI_MODE' (expected self-hosted)"
fi
if [ "$CLI_CLIENT" = "$SENTINEL_CLIENT_ID" ]; then
  pass "status CLI identity == the configured clientId"
else
  fail "status CLI reported client_id '$CLI_CLIENT' (expected $SENTINEL_CLIENT_ID)"
fi
if [ "$CLI_CLIENT" = "$CACHED_SAAS_TENANT" ]; then
  fail "status CLI reported the cached Community-SaaS tenant on a self-hosted install"
else
  pass "status CLI did not report the cached cs_ tenant that is present on disk"
fi

STATUS_TEXT="$( env -u AXONFLOW_ENDPOINT AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
    node "$STATUS_BIN" 2>/dev/null )"
if printf '%s' "$STATUS_TEXT" | grep -qF "endpoint:   $SENTINEL_URL  (mode=self-hosted)"; then
  pass "human-readable status names the endpoint and mode"
else
  fail "human-readable status does not name the endpoint/mode"
  printf '%s\n' "$STATUS_TEXT" | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# S2 — VACUITY CONTROL: without the record, the CLI gives the pre-fix answer
# ---------------------------------------------------------------------------
echo "--- S2: vacuity control — remove the record, expect the pre-fix answer ---"
mv "$RUNTIME_STATE_FILE" "$RUNTIME_STATE_FILE.bak" 2>/dev/null
CONTROL_JSON="$( env -u AXONFLOW_ENDPOINT AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
    node "$STATUS_BIN" --json 2>/dev/null )"
CONTROL_ENDPOINT=$(printf '%s' "$CONTROL_JSON" | jq -r '.endpoint // empty')
CONTROL_CLIENT=$(printf '%s' "$CONTROL_JSON" | jq -r '.client_id // empty')
if [ "$CONTROL_ENDPOINT" = "https://try.getaxonflow.com" ] && [ "$CONTROL_CLIENT" = "$CACHED_SAAS_TENANT" ]; then
  pass "control fired — without the record the CLI reproduces the v2.8.4 wrong answer ($CONTROL_ENDPOINT / $CONTROL_CLIENT)"
else
  fail "control did NOT fire: expected the SaaS default + cached tenant, got '$CONTROL_ENDPOINT' / '$CONTROL_CLIENT'. S1 may be passing for the wrong reason."
fi
mv "$RUNTIME_STATE_FILE.bak" "$RUNTIME_STATE_FILE" 2>/dev/null

# ---------------------------------------------------------------------------
# S3 — axonflow_get_tenant_id through a real agent dispatch
# ---------------------------------------------------------------------------
echo "--- S3: axonflow_get_tenant_id through a real agent turn ---"
# The tool runs INSIDE the runtime and is handed the live pluginConfig, so it
# must not consult the record at all. Proving that needs a control the RUNTIME
# cannot erase: an earlier revision planted a divergent record here, but
# `openclaw agent` loads the plugin, which rewrites the record from the live
# config before the tool ever runs — so a reverted in-process path would have
# read the corrected record and the leg passed either way.
#
# Instead make the record permanently unavailable to this turn by replacing it
# with a DIRECTORY. `writePluginRuntimeState` cannot rename over it (fails,
# non-fatal by design) and `readPluginRuntimeState` cannot read it (EISDIR →
# null). If the tool consulted the record it would now resolve the
# Community-SaaS default; only the live in-process config can still produce
# the sentinel. This doubles as a real test of the record-unwritable path.
rm -f "$RUNTIME_STATE_FILE"
mkdir -p "$RUNTIME_STATE_FILE"
TOOL_OUT="$(mktemp -t axonflow-status-truth-tool.XXXXXX)"
TOOL_PROMPT="Call the axonflow_get_tenant_id tool with no arguments. Then output exactly the literal text SMOKE_RESULT: followed by a single-line JSON object containing the tool's endpoint, tenant_id and mode values, like SMOKE_RESULT: {\"endpoint\":\"...\",\"tenant_id\":\"...\",\"mode\":\"...\"}."
env -u AXONFLOW_ENDPOINT AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
  timeout 180 openclaw agent --local --agent main --session-id "$(openclaw_fresh_session_id)" --model "$OPENCLAW_E2E_MODEL" \
    --message "$TOOL_PROMPT" --json --thinking off >"$TOOL_OUT" 2>/dev/null || true

TOOL_LINE=$(extract_smoke_line "$TOOL_OUT")
if [ -z "$TOOL_LINE" ]; then
  fail "agent did not emit SMOKE_RESULT for axonflow_get_tenant_id"
  jq -r '.payloads[]?.text // empty' "$TOOL_OUT" 2>/dev/null | head -5 | sed 's/^/      /'
else
  echo "      $TOOL_LINE"
  TOOL_ENDPOINT=$(printf '%s' "$TOOL_LINE" | jq -r '.endpoint // empty' 2>/dev/null)
  TOOL_TENANT=$(printf '%s' "$TOOL_LINE" | jq -r '.tenant_id // empty' 2>/dev/null)
  TOOL_MODE=$(printf '%s' "$TOOL_LINE" | jq -r '.mode // empty' 2>/dev/null)
  if [ "$TOOL_ENDPOINT" = "$SENTINEL_URL" ]; then
    pass "axonflow_get_tenant_id reports the self-hosted endpoint"
  else
    fail "axonflow_get_tenant_id reported endpoint '$TOOL_ENDPOINT' (expected $SENTINEL_URL)"
  fi
  if [ "$TOOL_TENANT" = "$SENTINEL_CLIENT_ID" ]; then
    pass "axonflow_get_tenant_id reports the identity in use, not the cached cs_ tenant"
  else
    fail "axonflow_get_tenant_id reported tenant_id '$TOOL_TENANT' (expected $SENTINEL_CLIENT_ID)"
  fi
  if [ "$TOOL_MODE" = "self-hosted" ]; then
    pass "axonflow_get_tenant_id reports mode=self-hosted"
  else
    fail "axonflow_get_tenant_id reported mode '$TOOL_MODE' (expected self-hosted)"
  fi
  # With the record unreadable, the Community-SaaS fallback is what a
  # record-reading implementation would have produced.
  if [ "$TOOL_ENDPOINT" = "https://try.getaxonflow.com" ] || [ "$TOOL_TENANT" = "$CACHED_SAAS_TENANT" ]; then
    fail "axonflow_get_tenant_id fell back to the record/registration path instead of the live config"
  else
    pass "axonflow_get_tenant_id answered with the record unreadable — in-process path proven"
  fi
fi
rm -f "$TOOL_OUT"

# Restore the record for the legs that follow.
rmdir "$RUNTIME_STATE_FILE" 2>/dev/null
( cd "$PLUGIN_DIR" && env -u AXONFLOW_ENDPOINT AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
    openclaw plugins install --force --dangerously-force-unsafe-install . ) >/dev/null 2>&1
if [ -f "$RUNTIME_STATE_FILE" ]; then
  pass "record restored by a normal plugin load after the unwritable-path control"
else
  fail "record was not restored after the control — later legs would be unsound"
fi

# ---------------------------------------------------------------------------
# S4 — a live AXONFLOW_ENDPOINT still outranks the recorded pluginConfig
# ---------------------------------------------------------------------------
echo "--- S4: live AXONFLOW_ENDPOINT beats the recorded pluginConfig ---"
ENV_OVERRIDE_URL="http://127.0.0.1:9"
OVERRIDE_JSON="$( env AXONFLOW_ENDPOINT="$ENV_OVERRIDE_URL" AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
    node "$STATUS_BIN" --json 2>/dev/null )"
OVERRIDE_ENDPOINT=$(printf '%s' "$OVERRIDE_JSON" | jq -r '.endpoint // empty')
if [ "$OVERRIDE_ENDPOINT" = "$ENV_OVERRIDE_URL" ]; then
  pass "persisted pluginConfig cannot outrank the caller's live AXONFLOW_ENDPOINT"
else
  fail "env override ignored: status reported '$OVERRIDE_ENDPOINT' (expected $ENV_OVERRIDE_URL)"
fi

# ---------------------------------------------------------------------------
# S5 — plugins doctor reports zero diagnostics
# ---------------------------------------------------------------------------
echo "--- S5: openclaw plugins doctor ---"
DOCTOR_OUT="$( env -u AXONFLOW_ENDPOINT AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
    openclaw plugins doctor 2>&1 )"
DOCTOR_HITS="$(printf '%s' "$DOCTOR_OUT" | grep -c "axonflow-governance" || true)"
if [ "$DOCTOR_HITS" = "0" ]; then
  pass "plugins doctor reports zero diagnostics for axonflow-governance"
else
  fail "plugins doctor reported $DOCTOR_HITS diagnostic line(s) for axonflow-governance"
  printf '%s\n' "$DOCTOR_OUT" | grep "axonflow-governance" | head -10 | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# S6 — the AXONFLOW_ENDPOINT channel: runtime env set, reader's shell clean
# ---------------------------------------------------------------------------
# Round-1 hostile review found that recording pluginConfig alone left #167
# fully intact through the other documented channel. This is that repro,
# through the real host and the real bin.
echo "--- S6: endpoint configured via AXONFLOW_ENDPOINT on the runtime only ---"
plugin_config_patch "{}" "endpoint clientId clientSecret"
ENV_ONLY_OUT="$( cd "$PLUGIN_DIR" && env AXONFLOW_ENDPOINT="$SENTINEL_URL" AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
    openclaw plugins install --force --dangerously-force-unsafe-install . 2>&1 )"
if printf '%s' "$ENV_ONLY_OUT" | grep -qF "[AxonFlow] Connected to AxonFlow at $SENTINEL_URL (mode=self-hosted)"; then
  pass "runtime resolved the env endpoint with mode=self-hosted"
else
  fail "runtime did not resolve the env endpoint"
  printf '%s\n' "$ENV_ONLY_OUT" | grep -F "[AxonFlow]" | head -3 | sed 's/^/      /'
fi

# The reader's shell deliberately does NOT export AXONFLOW_ENDPOINT.
ENV_ONLY_JSON="$( env -u AXONFLOW_ENDPOINT AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
    node "$STATUS_BIN" --json 2>/dev/null )"
S6_ENDPOINT=$(printf '%s' "$ENV_ONLY_JSON" | jq -r '.endpoint // empty')
S6_MODE=$(printf '%s' "$ENV_ONLY_JSON" | jq -r '.mode // empty')
S6_CLIENT=$(printf '%s' "$ENV_ONLY_JSON" | jq -r '.client_id // empty')
S6_SOURCE=$(printf '%s' "$ENV_ONLY_JSON" | jq -r '.config_recorded_source // empty')
if [ "$S6_ENDPOINT" = "$SENTINEL_URL" ] && [ "$S6_MODE" = "self-hosted" ]; then
  pass "status CLI reports the env-configured endpoint from a shell that does not export it"
else
  fail "status CLI reported '$S6_ENDPOINT' / '$S6_MODE' (expected $SENTINEL_URL / self-hosted)"
fi
if [ "$S6_CLIENT" = "$CACHED_SAAS_TENANT" ]; then
  fail "status CLI reported the cached cs_ tenant for an env-configured self-hosted install"
else
  pass "status CLI did not fall back to the cached cs_ tenant"
fi
if [ "$S6_SOURCE" = "env" ]; then
  pass "status CLI names the environment as the channel the value came from"
else
  fail "config_recorded_source was '$S6_SOURCE' (expected env)"
fi

# And the reader's OWN environment still wins, with the divergence surfaced.
DIVERGE_JSON="$( env AXONFLOW_ENDPOINT="http://127.0.0.1:9" AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
    node "$STATUS_BIN" --json 2>/dev/null )"
D_ENDPOINT=$(printf '%s' "$DIVERGE_JSON" | jq -r '.endpoint // empty')
D_ATLOAD=$(printf '%s' "$DIVERGE_JSON" | jq -r '.runtime_endpoint_at_last_load // empty')
if [ "$D_ENDPOINT" = "http://127.0.0.1:9" ] && [ "$D_ATLOAD" = "$SENTINEL_URL" ]; then
  pass "the reader's own env wins, and the endpoint the runtime is still on is reported alongside"
else
  fail "divergence not surfaced: endpoint='$D_ENDPOINT' runtime_endpoint_at_last_load='$D_ATLOAD'"
fi

echo ""
if [ "$errors" -ne 0 ]; then
  echo "FAILED: $errors error(s)"
  exit 1
fi
echo "status-identity-truth runtime E2E: ALL LEGS PASSED"
