#!/usr/bin/env bash
# OpenClaw runtime E2E: the network fail-open is announced, not silent (#167).
#
# Drives the REAL plugin through the REAL OpenClaw host and a REAL agent
# dispatch. E2E testing of 2.8.4 found that pointing the plugin at a dead
# endpoint let an agent turn execute a shell command containing
# `DROP TABLE users;` with no governance and no indication of any kind. The
# fail-open POLICY is deliberate and unchanged here; the silence is not.
#
#   F1. Endpoint pointed at a dead port. A real agent turn runs a governed
#       tool. The plugin's process output must carry the one-shot notice,
#       naming the dead endpoint and stating the call ran UNGOVERNED.
#   F2. Fail-open POLICY UNCHANGED: the tool still ran. A notice that came
#       with a block would be a different (unrequested) change.
#   F3. One-shot: a second governed tool call in the same process must not
#       repeat the notice.
#   F4. VACUITY CONTROL: with the endpoint alive, the same agent turn must
#       produce NO notice. If the notice appeared unconditionally it would
#       be noise, not signal.
#
# Env hygiene (#2937 class): AXONFLOW_ENDPOINT / AXONFLOW_CONFIG_DIR are
# commonly exported by the e2e driver shell, so every openclaw invocation
# pins or clears them explicitly, scoped to the single command.

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

# Port 9 (discard) is reserved and refuses connections on a normal host —
# a deterministic "endpoint is dead" without racing a teardown.
DEAD_URL="http://127.0.0.1:9"

CONFIG_BACKUP="$(mktemp -t axonflow-failopen-cfgbak.XXXXXX)"
cp "$OPENCLAW_CONFIG_FILE" "$CONFIG_BACKUP"
AXONFLOW_STATE_DIR="$(mktemp -d -t axonflow-failopen-state.XXXXXX)"
chmod 700 "$AXONFLOW_STATE_DIR"
LIVE_LOG="$(mktemp -t axonflow-failopen-live.XXXXXX)"
LIVE_PID=""

cleanup() {
  if [ -f "$CONFIG_BACKUP" ]; then
    cp "$CONFIG_BACKUP" "$OPENCLAW_CONFIG_FILE"
    rm -f "$CONFIG_BACKUP"
  fi
  [ -n "$LIVE_PID" ] && kill "$LIVE_PID" 2>/dev/null
  rm -rf "$AXONFLOW_STATE_DIR"
  rm -f "$LIVE_LOG" "${SECRET_ONE:-}" "${SECRET_TWO:-}"
}
trap cleanup EXIT INT TERM HUP

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

# Substring the notice must contain. Kept as a literal so a reword of the
# message that drops the "ungoverned" statement fails this test loudly.
NOTICE_MARKER="ran UNGOVERNED"

echo "--- Building + installing local OpenClaw plugin ---"
( cd "$PLUGIN_DIR" && npm run --silent build ) >/dev/null 2>&1 || { echo "FAIL: plugin build failed"; exit 1; }

# Two governed tool calls in one turn: proves the notice is one-shot per
# process rather than one per call.
#
# The tool calls must be UNAVOIDABLE. An earlier revision asked the model to
# `echo` two literal strings and asserted it reported them back — which a
# model can satisfy from the prompt alone without invoking any tool, and did:
# the run showed `toolSummary.calls = 0` while the assertion passed. Instead
# each step must read a secret this script generates and never puts in the
# prompt, so the only way to produce it is to actually execute the tool.
NONCE_ONE="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
NONCE_TWO="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
SECRET_ONE="$(mktemp -t axonflow-failopen-s1.XXXXXX)"
SECRET_TWO="$(mktemp -t axonflow-failopen-s2.XXXXXX)"
printf '%s' "$NONCE_ONE" >"$SECRET_ONE"
printf '%s' "$NONCE_TWO" >"$SECRET_TWO"

PROMPT="Do exactly two things, using a shell/bash tool for each, then report.
Step 1: run the command: cat $SECRET_ONE
Step 2: run the command: cat $SECRET_TWO
Do not guess the file contents — you must run both commands to read them.
Then output exactly the literal text SMOKE_RESULT: followed by single-line JSON like SMOKE_RESULT: {\"step1\":\"<exact stdout of step 1>\",\"step2\":\"<exact stdout of step 2>\"}."

run_turn() {
  local endpoint="$1" out_file="$2" err_file="$3"
  plugin_config_patch "{\"endpoint\": \"$endpoint\", \"clientId\": \"e2e-failopen\", \"clientSecret\": \"synth-tok-e2e\"}" ""
  ( cd "$PLUGIN_DIR" && env -u AXONFLOW_ENDPOINT AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
      openclaw plugins install --force --dangerously-force-unsafe-install . ) >/dev/null 2>&1
  env -u AXONFLOW_ENDPOINT AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
    timeout 180 openclaw agent --local --agent main --model "$OPENCLAW_E2E_MODEL" \
      --message "$PROMPT" --json --thinking off >"$out_file" 2>"$err_file" || true
}

# ---------------------------------------------------------------------------
# F1 + F2 + F3 — dead endpoint: announced once, tool still runs
# ---------------------------------------------------------------------------
echo "--- F1/F2/F3: dead endpoint ($DEAD_URL) ---"
DEAD_OUT="$(mktemp -t axonflow-failopen-deadout.XXXXXX)"
DEAD_ERR="$(mktemp -t axonflow-failopen-deaderr.XXXXXX)"
run_turn "$DEAD_URL" "$DEAD_OUT" "$DEAD_ERR"

NOTICE_COUNT=$(grep -c "$NOTICE_MARKER" "$DEAD_ERR" 2>/dev/null || true)
NOTICE_COUNT=${NOTICE_COUNT:-0}

if [ "$NOTICE_COUNT" -ge 1 ]; then
  pass "fail-open notice surfaced to the session"
  grep -m1 "$NOTICE_MARKER" "$DEAD_ERR" | sed 's/^/      /'
else
  fail "no fail-open notice in the agent session output — governance went off silently"
  tail -20 "$DEAD_ERR" | sed 's/^/      /'
fi

# Grep the NOTICE LINE, not the whole stream. The same stderr already carries
# the init canary ("Connected to AxonFlow at <url>") and the health-check
# warning, both naming this endpoint — a whole-stream grep would pass with the
# notice entirely absent.
if grep "$NOTICE_MARKER" "$DEAD_ERR" 2>/dev/null | grep -q "$DEAD_URL"; then
  pass "the notice line itself names the unreachable endpoint"
else
  fail "the notice line does not name $DEAD_URL"
fi

# F3: one-shot. EXACTLY one, not "at most one" — `-le 1` would also pass at
# zero, i.e. when the feature is missing entirely.
if [ "$NOTICE_COUNT" -eq 1 ]; then
  pass "notice emitted exactly once for the whole session (count=$NOTICE_COUNT)"
else
  fail "expected exactly 1 notice for the session, got $NOTICE_COUNT"
fi

# ...and the latch is only under test if MORE THAN ONE governed tool call
# actually hit the dead endpoint. Count real tool dispatches from the agent
# transcript rather than trusting the model's own summary text.
# OpenClaw reports the authoritative count at .meta.toolSummary.calls
# (alongside .tools / .failures). Read it there rather than counting shapes.
TOOL_CALLS=$(jq -r '(.meta.toolSummary.calls // .meta.agentMeta.toolSummary.calls // 0)' "$DEAD_OUT" 2>/dev/null || echo 0)
case "$TOOL_CALLS" in ''|*[!0-9]*) TOOL_CALLS=0 ;; esac
if [ "$TOOL_CALLS" -ge 2 ]; then
  pass "the turn dispatched $TOOL_CALLS tool calls, so the one-shot latch was genuinely exercised"
else
  fail "only $TOOL_CALLS tool dispatch(es) observed — the one-shot assertion above is vacuous"
  jq -r '.payloads[]?.text // empty' "$DEAD_OUT" 2>/dev/null | head -5 | sed 's/^/      /'
fi

# F2: the fail-open POLICY is unchanged — the governed tools still ran. The
# nonces are only obtainable by executing both commands, so reporting them
# back is proof of execution rather than proof of plausible narration.
DEAD_LINE=$(extract_smoke_line "$DEAD_OUT")
if [ -n "$DEAD_LINE" ] \
   && printf '%s' "$DEAD_LINE" | grep -q "$NONCE_ONE" \
   && printf '%s' "$DEAD_LINE" | grep -q "$NONCE_TWO"; then
  pass "fail-open policy unchanged — both governed tool calls executed against the dead endpoint"
else
  fail "governed tool calls did not execute against a dead endpoint; the fail-open policy was changed"
  echo "      SMOKE_RESULT: ${DEAD_LINE:-<none>}"
  jq -r '.payloads[]?.text // empty' "$DEAD_OUT" 2>/dev/null | head -5 | sed 's/^/      /'
fi
rm -f "$DEAD_OUT" "$DEAD_ERR"

# ---------------------------------------------------------------------------
# F4 — VACUITY CONTROL: a reachable endpoint produces no notice
# ---------------------------------------------------------------------------
echo "--- F4: vacuity control — reachable endpoint, expect NO notice ---"
LISTENER_LOG="$LIVE_LOG" python3 - <<'PY' >"$AXONFLOW_STATE_DIR/port" &
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
LIVE_PID=$!
for _ in $(seq 1 20); do
  [ -s "$AXONFLOW_STATE_DIR/port" ] && break
  sleep 0.25
done
LIVE_PORT="$(cat "$AXONFLOW_STATE_DIR/port" 2>/dev/null)"
if [ -z "$LIVE_PORT" ]; then
  fail "could not start the control listener — vacuity control did not run"
else
  LIVE_URL="http://127.0.0.1:$LIVE_PORT"
  LIVE_OUT="$(mktemp -t axonflow-failopen-liveout.XXXXXX)"
  LIVE_ERR="$(mktemp -t axonflow-failopen-liveerr.XXXXXX)"
  run_turn "$LIVE_URL" "$LIVE_OUT" "$LIVE_ERR"

  # Control must have FIRED: the governed calls really did reach the
  # listener. Absence of a notice means nothing if nothing was governed.
  LIVE_TOOL_CALLS=$(jq -r '(.meta.toolSummary.calls // .meta.agentMeta.toolSummary.calls // 0)' "$LIVE_OUT" 2>/dev/null || echo 0)
  case "$LIVE_TOOL_CALLS" in ''|*[!0-9]*) LIVE_TOOL_CALLS=0 ;; esac
  if [ "$LIVE_TOOL_CALLS" -lt 1 ]; then
    fail "the control turn dispatched no tool calls at all — nothing was governed, so the no-notice assertion below is vacuous"
    jq -r '.payloads[]?.text // empty' "$LIVE_OUT" 2>/dev/null | head -5 | sed 's/^/      /'
  elif grep -q "POST /api/v1/mcp/check-input" "$LIVE_LOG" 2>/dev/null; then
    pass "control fired — $LIVE_TOOL_CALLS governed tool call(s) reached the live endpoint as check-input"
  else
    fail "$LIVE_TOOL_CALLS tool call(s) dispatched but no check-input reached the live endpoint; the no-notice assertion below is vacuous"
    echo "      listener log:"; head -10 "$LIVE_LOG" 2>/dev/null | sed 's/^/        /'
  fi

  if grep -q "$NOTICE_MARKER" "$LIVE_ERR" 2>/dev/null; then
    fail "fail-open notice appeared against a REACHABLE endpoint — the notice is noise, not signal"
    grep -m1 "$NOTICE_MARKER" "$LIVE_ERR" | sed 's/^/      /'
  else
    pass "no fail-open notice against a reachable endpoint"
  fi
  rm -f "$LIVE_OUT" "$LIVE_ERR"
fi

echo ""
if [ "$errors" -ne 0 ]; then
  echo "FAILED: $errors error(s)"
  exit 1
fi
echo "failopen-notice runtime E2E: ALL LEGS PASSED"
