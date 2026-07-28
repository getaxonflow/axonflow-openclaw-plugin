#!/usr/bin/env bash
# OpenClaw runtime E2E: AXONFLOW_ENDPOINT governance-runtime override (#162).
#
# Drives the REAL plugin through the REAL OpenClaw host (`openclaw plugins
# install`) and proves the documented endpoint precedence with live traffic:
#
#   E1. AXONFLOW_ENDPOINT set to a local SENTINEL listener while
#       pluginConfig.endpoint points at a DIFFERENT local DECOY listener →
#       the init canary reports the SENTINEL with mode=self-hosted, the
#       plugin's startup traffic (the /health check the governance client
#       fires at register time) reaches the SENTINEL, the DECOY receives
#       ZERO requests, and no Community-SaaS registration runs. Through
#       v2.8.3 this leg fails: the canary/status showed the env endpoint
#       while governed traffic used the pluginConfig/default resolution.
#   E2. env cleared, pluginConfig.endpoint = sentinel → pluginConfig channel
#       still resolves (canary + traffic on the sentinel).
#   E3. env set to whitespace-only, pluginConfig.endpoint = sentinel →
#       whitespace env is ignored, pluginConfig wins (canary on sentinel).
#
# Env hygiene (#2937 class): AXONFLOW_ENDPOINT is commonly exported by the
# e2e driver shell for the _lib defaults — every openclaw invocation below
# pins or clears it explicitly with `env VAR=` / `env -u VAR`, scoped to
# the single command.

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

CONFIG_BACKUP="$(mktemp -t axonflow-endpoint-env-cfgbak.XXXXXX)"
cp "$OPENCLAW_CONFIG_FILE" "$CONFIG_BACKUP"

# Isolate the AxonFlow config dir. Since #167 every plugin load writes a
# runtime-state record there, and this suite deliberately points the plugin
# at ephemeral sentinel ports — without isolation it would leave a record in
# the developer's real config dir naming a dead port, which a later genuine
# `axonflow-openclaw-status` run would report as the live endpoint.
AXONFLOW_STATE_DIR="$(mktemp -d -t axonflow-endpoint-env-state.XXXXXX)"
chmod 700 "$AXONFLOW_STATE_DIR"
export AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR"

SENTINEL_LOG="$(mktemp -t axonflow-endpoint-env-sentinel.XXXXXX)"
DECOY_LOG="$(mktemp -t axonflow-endpoint-env-decoy.XXXXXX)"
SENTINEL_PID=""
DECOY_PID=""

cleanup() {
  if [ -f "$CONFIG_BACKUP" ]; then
    cp "$CONFIG_BACKUP" "$OPENCLAW_CONFIG_FILE"
    rm -f "$CONFIG_BACKUP"
  fi
  [ -n "$SENTINEL_PID" ] && kill "$SENTINEL_PID" 2>/dev/null
  [ -n "$DECOY_PID" ] && kill "$DECOY_PID" 2>/dev/null
  rm -rf "$AXONFLOW_STATE_DIR"
  rm -f "$SENTINEL_LOG" "$DECOY_LOG"
}
trap cleanup EXIT INT TERM HUP

# Minimal HTTP listener: appends "METHOD PATH" per request to a log file and
# answers 200 {} to everything (the startup /health probe only needs 2xx).
# Prints the bound port on stdout, then serves until killed.
start_listener() {
  local log="$1"
  LISTENER_LOG="$log" python3 - <<'PY' &
import http.server, json, os, sys, threading

log_path = os.environ["LISTENER_LOG"]
lock = threading.Lock()

class Handler(http.server.BaseHTTPRequestHandler):
    def _record(self):
        with lock, open(log_path, "a") as f:
            f.write(f"{self.command} {self.path}\n")
        body = json.dumps({"status": "ok"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    do_GET = _record
    do_POST = _record
    do_HEAD = _record
    def log_message(self, *args):  # silence default stderr access log
        pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
PY
}

# Start both listeners and capture their ports.
SENTINEL_PORT_FILE="$(mktemp -t axonflow-endpoint-env-sport.XXXXXX)"
DECOY_PORT_FILE="$(mktemp -t axonflow-endpoint-env-dport.XXXXXX)"
start_listener "$SENTINEL_LOG" >"$SENTINEL_PORT_FILE"
SENTINEL_PID=$!
start_listener "$DECOY_LOG" >"$DECOY_PORT_FILE"
DECOY_PID=$!
for _ in $(seq 1 20); do
  [ -s "$SENTINEL_PORT_FILE" ] && [ -s "$DECOY_PORT_FILE" ] && break
  sleep 0.25
done
SENTINEL_PORT="$(cat "$SENTINEL_PORT_FILE")"; rm -f "$SENTINEL_PORT_FILE"
DECOY_PORT="$(cat "$DECOY_PORT_FILE")"; rm -f "$DECOY_PORT_FILE"
if [ -z "$SENTINEL_PORT" ] || [ -z "$DECOY_PORT" ]; then
  echo "SKIP: could not start local listeners"
  exit 0
fi
SENTINEL_URL="http://127.0.0.1:$SENTINEL_PORT"
DECOY_URL="http://127.0.0.1:$DECOY_PORT"
echo "--- sentinel=$SENTINEL_URL decoy=$DECOY_URL ---"

# Edit the plugin's config block directly (same helper as the sibling
# suites) so each leg controls pluginConfig.endpoint deterministically.
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

echo "--- Building + installing local OpenClaw plugin ---"
openclaw_install_local_plugin || exit 1

# Wait until the given log file contains a /health request (the startup
# health probe is fire-and-forget; give it a few seconds to land).
wait_for_health_hit() {
  local log="$1" n=0
  while [ "$n" -lt 20 ]; do
    grep -q "GET /health" "$log" 2>/dev/null && return 0
    n=$((n + 1)); sleep 0.5
  done
  return 1
}

errors=0

# ---------------------------------------------------------------------------
# E1 — env sentinel beats pluginConfig decoy; traffic follows the env value
# ---------------------------------------------------------------------------
echo "--- E1: AXONFLOW_ENDPOINT (sentinel) wins over pluginConfig.endpoint (decoy) ---"
: >"$SENTINEL_LOG"; : >"$DECOY_LOG"
plugin_config_patch "{\"endpoint\": \"$DECOY_URL\", \"clientId\": \"e2e-tenant\", \"clientSecret\": \"e2e-secret\"}" ""
OUT_E1="$( cd "$PLUGIN_DIR" && env AXONFLOW_ENDPOINT="$SENTINEL_URL" \
    openclaw plugins install --force --dangerously-force-unsafe-install . 2>&1 )"

if printf '%s' "$OUT_E1" | grep -qF "[AxonFlow] Connected to AxonFlow at $SENTINEL_URL (mode=self-hosted)"; then
  echo "PASS: init canary reports the env endpoint with mode=self-hosted"
else
  echo "FAIL: canary does not report the env endpoint / self-hosted mode"
  printf '%s\n' "$OUT_E1" | grep -F "[AxonFlow]" | head -3 | sed 's/^/      /'
  errors=$((errors + 1))
fi
if wait_for_health_hit "$SENTINEL_LOG"; then
  echo "PASS: startup health probe reached the env-configured sentinel"
else
  echo "FAIL: no /health request reached the sentinel listener"
  errors=$((errors + 1))
fi
if [ -s "$DECOY_LOG" ]; then
  echo "FAIL: pluginConfig decoy endpoint received traffic despite the env override:"
  head -5 "$DECOY_LOG" | sed 's/^/      /'
  errors=$((errors + 1))
else
  echo "PASS: decoy (pluginConfig) endpoint received ZERO requests"
fi
if printf '%s' "$OUT_E1" | grep -q "Community SaaS registration"; then
  echo "FAIL: Community-SaaS registration ran despite an env-provided endpoint"
  errors=$((errors + 1))
else
  echo "PASS: no Community-SaaS registration with an env-provided endpoint"
fi

# ---------------------------------------------------------------------------
# E2 — env cleared → pluginConfig.endpoint still resolves
# ---------------------------------------------------------------------------
echo "--- E2: pluginConfig.endpoint honoured when env is unset ---"
: >"$SENTINEL_LOG"
plugin_config_patch "{\"endpoint\": \"$SENTINEL_URL\"}" ""
OUT_E2="$( cd "$PLUGIN_DIR" && env -u AXONFLOW_ENDPOINT \
    openclaw plugins install --force --dangerously-force-unsafe-install . 2>&1 )"
if printf '%s' "$OUT_E2" | grep -qF "[AxonFlow] Connected to AxonFlow at $SENTINEL_URL (mode=self-hosted)"; then
  echo "PASS: canary reports the pluginConfig endpoint when env is unset"
else
  echo "FAIL: pluginConfig endpoint not honoured with env unset"
  printf '%s\n' "$OUT_E2" | grep -F "[AxonFlow]" | head -3 | sed 's/^/      /'
  errors=$((errors + 1))
fi
if wait_for_health_hit "$SENTINEL_LOG"; then
  echo "PASS: startup health probe reached the pluginConfig endpoint"
else
  echo "FAIL: no /health request reached the pluginConfig endpoint"
  errors=$((errors + 1))
fi

# ---------------------------------------------------------------------------
# E3 — whitespace-only env is ignored → pluginConfig wins
# ---------------------------------------------------------------------------
echo "--- E3: whitespace-only AXONFLOW_ENDPOINT is ignored ---"
OUT_E3="$( cd "$PLUGIN_DIR" && env AXONFLOW_ENDPOINT="   " \
    openclaw plugins install --force --dangerously-force-unsafe-install . 2>&1 )"
if printf '%s' "$OUT_E3" | grep -qF "[AxonFlow] Connected to AxonFlow at $SENTINEL_URL (mode=self-hosted)"; then
  echo "PASS: whitespace-only env ignored; pluginConfig endpoint used"
else
  echo "FAIL: whitespace-only env changed the resolved endpoint"
  printf '%s\n' "$OUT_E3" | grep -F "[AxonFlow]" | head -3 | sed 's/^/      /'
  errors=$((errors + 1))
fi

echo ""
if [ "$errors" -ne 0 ]; then
  echo "FAILED: $errors error(s)"
  exit 1
fi
echo "endpoint-env-override runtime E2E: ALL LEGS PASSED"
