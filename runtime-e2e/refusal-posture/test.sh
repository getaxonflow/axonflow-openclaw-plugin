#!/usr/bin/env bash
# OpenClaw runtime E2E: a refused governance check blocks by default and is
# never silent (#196).
#
# Drives the REAL plugin through the REAL OpenClaw host and a REAL agent
# dispatch against a live AxonFlow community stack, with a client id the
# organization has not admitted:
#
#   R1. onError "block" (the default): the governed tool call is BLOCKED (it
#       never runs), the platform's refusal reaches the agent, and the auth
#       breaker's "Authentication failed (HTTP 401)" warning never appears: a
#       refusal is not a rejected credential.
#   R2. onError "allow": the governed tool call RUNS, and the one-shot notice
#       says it ran ungoverned.
#   R3. VACUITY CONTROL: the suite's own admitted client, onError "block": the
#       tool call runs, with no notice and no block.
#
# How the refusal is produced. A community agent checks no client secret, but
# admits at most 5 service principals per organization; past that ceiling a
# new client id is refused, with HTTP 402 ERR_TIER_LIMIT_SERVICE_PRINCIPAL on
# the REST routes the plugin calls (check-input, check-output). This suite
# first sends one request as its own client, which keeps that client admitted,
# then new client ids until one is refused: at most 5 requests. On a stack below
# its ceiling those requests ADMIT new client ids, and a later suite presenting
# a client id the organization has not admitted is then refused. Run it on a
# stack you can reset, or last.

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

CONFIG_BACKUP="$(mktemp -t axonflow-refusal-cfgbak.XXXXXX)"
cp "$OPENCLAW_CONFIG_FILE" "$CONFIG_BACKUP"
AXONFLOW_STATE_DIR="$(mktemp -d -t axonflow-refusal-state.XXXXXX)"
chmod 700 "$AXONFLOW_STATE_DIR"
SECRET_FILE="$(mktemp -t axonflow-refusal-secret.XXXXXX)"

cleanup() {
  if [ -f "$CONFIG_BACKUP" ]; then
    cp "$CONFIG_BACKUP" "$OPENCLAW_CONFIG_FILE"
    rm -f "$CONFIG_BACKUP"
  fi
  rm -rf "$AXONFLOW_STATE_DIR"
  rm -f "$SECRET_FILE"
}
trap cleanup EXIT INT TERM HUP

errors=0
fail() { echo "FAIL: $1"; errors=$((errors + 1)); }
pass() { echo "PASS: $1"; }

# check_status_as <client id>: the HTTP status check-input answers for it.
check_status_as() {
  curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Basic $(printf '%s:refusal-posture' "$1" | base64 | tr -d '\n')" \
    -H "Content-Type: application/json" \
    -d '{"connector_type":"openclaw.bash","statement":"{\"command\":\"echo refusal-posture\"}","operation":"execute"}' \
    "$AXONFLOW_ENDPOINT/api/v1/mcp/check-input"
}

echo "--- Producing a refused client id ---"
OWN_STATUS=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Basic $(printf '%s:%s' "$AXONFLOW_CLIENT_ID" "$AXONFLOW_CLIENT_SECRET" | base64 | tr -d '\n')" \
  -H "Content-Type: application/json" \
  -d '{"connector_type":"openclaw.bash","statement":"{\"command\":\"echo refusal-posture\"}","operation":"execute"}' \
  "$AXONFLOW_ENDPOINT/api/v1/mcp/check-input")
UNADMITTED=""
for i in 1 2 3 4 5; do
  candidate="refusal-posture-$(date +%s)-$$-$i"
  if [ "$(check_status_as "$candidate")" = "402" ]; then
    UNADMITTED="$candidate"
    break
  fi
done
if [ -z "$UNADMITTED" ]; then
  echo "FAIL: no refusal: this suite's own client answered HTTP $OWN_STATUS and 5 new client ids were all admitted"
  exit 1
fi
echo "(check-input refused client id $UNADMITTED with HTTP 402)"

plugin_config_set() {
  CONFIG_FILE="$OPENCLAW_CONFIG_FILE" SET_KEYS="$1" python3 - <<'PY'
import json, os
path = os.environ["CONFIG_FILE"]
cfg = json.load(open(path))
entry = cfg.setdefault("plugins", {}).setdefault("entries", {}).setdefault("axonflow-governance", {})
block = entry.setdefault("config", {})
for key in ("endpoint", "clientId", "clientSecret", "onError", "failMode"):
    block.pop(key, None)
block.update(json.loads(os.environ["SET_KEYS"]))
json.dump(cfg, open(path, "w"), indent=2)
PY
}

echo "--- Building the local OpenClaw plugin ---"
( cd "$PLUGIN_DIR" && npm run --silent build ) >/dev/null 2>&1 || { echo "FAIL: plugin build failed"; exit 1; }

# The tool call must be unavoidable: the nonce is in a file this script writes
# and never in the prompt, so only an executed tool call can report it.
PROMPT="Use a shell/bash tool to run the command: cat $SECRET_FILE
Do not guess the file contents. If the tool call is blocked or fails, do not retry it.
Then output exactly the literal text SMOKE_RESULT: followed by single-line JSON like SMOKE_RESULT: {\"stdout\":\"<exact stdout, or empty if the call did not run>\",\"error\":\"<the exact error text you got instead, or empty>\"}."

run_turn() {  # run_turn <plugin config JSON> <out file> <err file>
  local nonce
  nonce="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf '%s' "$nonce" >"$SECRET_FILE"
  CURRENT_NONCE="$nonce"
  plugin_config_set "$1"
  ( cd "$PLUGIN_DIR" && env -u AXONFLOW_ENDPOINT -u AXONFLOW_FAIL_MODE AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
      openclaw plugins install --force --dangerously-force-unsafe-install . ) >/dev/null 2>&1
  env -u AXONFLOW_ENDPOINT -u AXONFLOW_FAIL_MODE AXONFLOW_CONFIG_DIR="$AXONFLOW_STATE_DIR" \
    timeout 180 openclaw agent --local --agent main --session-id "$(openclaw_fresh_session_id)" --model "$OPENCLAW_E2E_MODEL" \
      --message "$PROMPT" --json --thinking off >"$2" 2>"$3" || true
}

tool_calls() {
  local n
  n=$(jq -r '(.meta.toolSummary.calls // .meta.agentMeta.toolSummary.calls // 0)' "$1" 2>/dev/null || echo 0)
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  echo "$n"
}

NOTICE_MARKER="ran UNGOVERNED"
BREAKER_MARKER="Authentication failed (HTTP 401)"
OUT="$(mktemp -t axonflow-refusal-out.XXXXXX)"
ERR="$(mktemp -t axonflow-refusal-err.XXXXXX)"

# ---------------------------------------------------------------------------
echo "--- R1: refused client, onError=block ---"
run_turn "{\"endpoint\": \"$AXONFLOW_ENDPOINT\", \"clientId\": \"$UNADMITTED\", \"clientSecret\": \"refusal-posture\", \"onError\": \"block\"}" "$OUT" "$ERR"
LINE=$(extract_smoke_line "$OUT")
if [ "$(tool_calls "$OUT")" -lt 1 ]; then
  fail "R1: the turn attempted no tool call, so the block assertions below are vacuous"
elif printf '%s' "$LINE" | grep -q "$CURRENT_NONCE"; then
  fail "R1: the governed tool call RAN for a refused client under onError=block"
else
  pass "R1: the governed tool call was blocked (its output never reached the agent)"
fi
if { printf '%s' "$LINE"; jq -r '.payloads[]?.text // empty' "$OUT" 2>/dev/null; cat "$ERR"; } | grep -qE "ERR_TIER_LIMIT_SERVICE_PRINCIPAL|refused the governance check"; then
  pass "R1: the platform's refusal reached the session"
else
  fail "R1: no refusal text (ERR_TIER_LIMIT_SERVICE_PRINCIPAL / refused the governance check) in the session"
  echo "      SMOKE_RESULT: ${LINE:-<none>}"
fi
if grep -qF "$BREAKER_MARKER" "$ERR" 2>/dev/null; then
  fail "R1: the auth breaker's warning appeared: a refusal was read as a rejected credential"
else
  pass "R1: the auth breaker was not tripped by the refusal"
fi

# ---------------------------------------------------------------------------
echo "--- R2: refused client, onError=allow ---"
run_turn "{\"endpoint\": \"$AXONFLOW_ENDPOINT\", \"clientId\": \"$UNADMITTED\", \"clientSecret\": \"refusal-posture\", \"onError\": \"allow\"}" "$OUT" "$ERR"
LINE=$(extract_smoke_line "$OUT")
if printf '%s' "$LINE" | grep -q "$CURRENT_NONCE"; then
  pass "R2: the tool call ran under onError=allow"
else
  fail "R2: the tool call did not run under onError=allow (SMOKE_RESULT: ${LINE:-<none>})"
fi
if grep -qF "$NOTICE_MARKER" "$ERR" 2>/dev/null; then
  pass "R2: the one-shot notice says the call ran ungoverned"
  grep -m1 -F "$NOTICE_MARKER" "$ERR" | cut -c1-200 | sed 's/^/      /'
else
  fail "R2: no \"$NOTICE_MARKER\" notice: the refused check proceeded silently"
fi

# ---------------------------------------------------------------------------
echo "--- R3: vacuity control, the suite's own client, onError=block ---"
run_turn "{\"endpoint\": \"$AXONFLOW_ENDPOINT\", \"clientId\": \"$AXONFLOW_CLIENT_ID\", \"clientSecret\": \"$AXONFLOW_CLIENT_SECRET\", \"onError\": \"block\"}" "$OUT" "$ERR"
LINE=$(extract_smoke_line "$OUT")
if printf '%s' "$LINE" | grep -q "$CURRENT_NONCE"; then
  pass "R3: an admitted client's tool call runs"
else
  fail "R3: an admitted client's tool call did not run, so R1's block is not attributable to the refusal (SMOKE_RESULT: ${LINE:-<none>})"
fi
if grep -qF "$NOTICE_MARKER" "$ERR" 2>/dev/null; then
  fail "R3: the notice appeared for an admitted client: it is noise, not signal"
else
  pass "R3: no notice for an admitted client"
fi
rm -f "$OUT" "$ERR"

echo ""
if [ "$errors" -ne 0 ]; then
  echo "FAILED: $errors error(s)"
  exit 1
fi
echo "refusal-posture runtime E2E: ALL LEGS PASSED"
