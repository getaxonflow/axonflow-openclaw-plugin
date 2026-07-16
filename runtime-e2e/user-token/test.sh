#!/usr/bin/env bash
# OpenClaw runtime E2E: per-user token (X-User-Token) OUTCOME test
# (axonflow-enterprise#2945, epic #2919; parity with axonflow-claude-plugin#107).
#
# Drives the REAL plugin through the REAL OpenClaw host (`openclaw plugins
# install` + `openclaw agent --local`) against a LIVE AxonFlow agent — no
# mocks — and asserts:
#
#   Loader legs (the v2.0.4 configSchema loader-skip regression class —
#   this repo's own CHANGELOG post-mortem; an ungoverned fleet is worse
#   than a token-less one):
#     L1. config containing `userToken` → the plugin LOADS (schema accepts
#         the key), registers its agent tools, and emits the value-free
#         "Per-user token configured" canary.
#     L2. config without `userToken` → plugin loads with NO token canary
#         (init output unchanged from v2.6.7).
#     L3. config containing a genuinely-unknown key → the loader REJECTS
#         ("must NOT have additional properties") and does NOT register the
#         plugin — proves L1 passed because the key is declared, not
#         because the schema gate was loosened.
#
#   Token legs (need a platform that validates X-User-Token,
#   enterprise#2929+, plus DB access for attribution read-back):
#     L4. valid minted token + FORGED userEmail → audit_logs rows attribute
#         to the token's canonical email; ZERO rows attribute to the forged
#         label. Covers both governed planes the agent turn exercises:
#         before_tool_call → /api/v1/mcp/check-input AND the agent-tool
#         axonflow_audit_search → /api/v1/mcp-server tools/call.
#     L5. TAMPERED token (first signature char flipped — flipping the last
#         char can land in base64 padding bits and still verify) → the
#         governed tool call is BLOCKED (fail-closed on a presented-but-
#         invalid credential; onError=block) and the token value appears
#         NOWHERE in the agent output.
#     L6. unconfigured → governed traffic still flows and attributes via
#         the pre-existing label path (byte-identical behavior; the common
#         fleet state today).
#
# Capability probe: pre-#2929 platforms IGNORE X-User-Token. A garbage
# token on a bare MCP initialize must 401 for legs 4-5 to be meaningful;
# otherwise they SKIP with a notice.
#
# PREREQ ENV (test-driver shell):
#   AXONFLOW_ENDPOINT        — agent base URL (default http://localhost:8080)
#   AXONFLOW_CLIENT_ID       — tenant id (enterprise: org id)
#   AXONFLOW_CLIENT_SECRET   — tenant secret (enterprise: license key)
#   AXONFLOW_E2E_DB_URL      — postgres URL for audit_logs read-back (legs 4-6)
#   AXONFLOW_E2E_USER_TOKEN + AXONFLOW_E2E_USER_TOKEN_EMAIL — a real minted
#       token, OR AXONFLOW_E2E_JWT_SECRET + AXONFLOW_E2E_ORG_ID to self-sign
#       one with the exact mint-API claims contract (platform/shared/identity:
#       iss=axonflow-user-token-mint, email, role, org_id, jti, iat, exp).
#       The platform performs its FULL validation — nothing is stubbed.
#   OPENCLAW_E2E_MODEL       — model for agent turns (needs a provider key
#                              configured in the local openclaw)
#
# The run mutates the local openclaw config (same as the sibling suites);
# the plugin entry's config block is snapshotted and restored on exit.
# NOTE (#2937 class): AXONFLOW_USER_TOKEN may be exported by unrelated
# tooling (e.g. setup-e2e-testing.sh legacy examples JWT) — every openclaw
# invocation below pins or clears it explicitly with `env -u/env VAR=`.

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

CONFIG_BACKUP="$(mktemp -t axonflow-user-token-cfgbak.XXXXXX)"
cp "$OPENCLAW_CONFIG_FILE" "$CONFIG_BACKUP"

# Neutralize the THIRD resolution source for the whole run: a real
# provisioning file at ~/.config/axonflow/user-token.json (written by fleet
# tooling or a sibling plugin's e2e) would make the "unconfigured" legs
# (L2/L6) resolve a token via the file — L2 would false-FAIL on the canary
# and L6 would prove the wrong thing. Move it aside; restore on exit.
PROVISIONING_FILE="$HOME/.config/axonflow/user-token.json"
PROVISIONING_STASH=""
if [ -f "$PROVISIONING_FILE" ]; then
  PROVISIONING_STASH="$(mktemp -t axonflow-user-token-filestash.XXXXXX)"
  mv "$PROVISIONING_FILE" "$PROVISIONING_STASH"
  echo "--- Stashed real provisioning file $PROVISIONING_FILE for the run ---"
fi

restore_config() {
  cp "$CONFIG_BACKUP" "$OPENCLAW_CONFIG_FILE"
  rm -f "$CONFIG_BACKUP"
  if [ -n "$PROVISIONING_STASH" ] && [ -f "$PROVISIONING_STASH" ]; then
    mv "$PROVISIONING_STASH" "$PROVISIONING_FILE"
    chmod 600 "$PROVISIONING_FILE" 2>/dev/null || true
  fi
}
trap restore_config EXIT

# Write/delete keys in the plugin's config block by editing the config file
# directly — `openclaw config set` validates against the INSTALLED schema,
# which is exactly what leg L3 needs to bypass to reproduce the loader-skip
# class (the incident scenario is a config written by another channel: MDM,
# an older CLI, a hand edit).
plugin_config_patch() {
  # $1 = python dict-literal of keys to set; $2 = space-separated keys to delete
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

# Install once with the CURRENT (restored) config so the new manifest's
# schema is what the loader validates against for every leg.
echo "--- Building + installing local OpenClaw plugin ---"
openclaw_install_local_plugin || exit 1

install_and_capture() {
  # Re-runs the install (which loads the plugin against the current config)
  # and captures the loader + plugin-init output. AXONFLOW_USER_TOKEN is
  # explicitly cleared so only pluginConfig drives the loader legs.
  ( cd "$PLUGIN_DIR" && env -u AXONFLOW_USER_TOKEN \
      openclaw plugins install --force --dangerously-force-unsafe-install . 2>&1 )
}

errors=0

# A syntactically wire-safe sentinel for the loader legs — never needs to
# validate server-side; the loader legs only exercise schema + init.
SENTINEL_TOKEN="eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImxvYWRlci1sZWdAZXhhbXBsZS5jb20ifQ.c2VudGluZWw"

# ---------------------------------------------------------------------------
# L1 — userToken present → plugin LOADS + canary (the key is schema-declared)
# ---------------------------------------------------------------------------
echo "--- L1: plugin loads with pluginConfig.userToken present ---"
plugin_config_patch "{\"userToken\": \"$SENTINEL_TOKEN\"}" ""
OUT_L1="$(install_and_capture)"
if printf '%s' "$OUT_L1" | grep -qE "Registered [0-9]+ agent-callable tools"; then
  echo "PASS: plugin registered with userToken in config (no loader skip)"
else
  echo "FAIL: plugin did NOT register with userToken in config — loader-skip regression"
  printf '%s\n' "$OUT_L1" | tail -8 | sed 's/^/      /'
  errors=$((errors + 1))
fi
if printf '%s' "$OUT_L1" | grep -q "Per-user token configured (source: pluginConfig.userToken)"; then
  echo "PASS: per-user token canary emitted, names the source"
else
  echo "FAIL: per-user token canary missing from init output"
  errors=$((errors + 1))
fi
if printf '%s' "$OUT_L1" | grep -qF "$SENTINEL_TOKEN"; then
  echo "FAIL: init output leaked the token value"
  errors=$((errors + 1))
else
  echo "PASS: init output does not contain the token value"
fi

# ---------------------------------------------------------------------------
# L2 — userToken absent → plugin loads, NO token canary (v2.6.7-identical init)
# ---------------------------------------------------------------------------
echo "--- L2: plugin loads without userToken (no canary) ---"
plugin_config_patch "" "userToken"
OUT_L2="$(install_and_capture)"
if printf '%s' "$OUT_L2" | grep -qE "Registered [0-9]+ agent-callable tools"; then
  echo "PASS: plugin registered without userToken"
else
  echo "FAIL: plugin did not register without userToken"
  errors=$((errors + 1))
fi
if printf '%s' "$OUT_L2" | grep -q "Per-user token"; then
  echo "FAIL: token canary emitted despite no token configured"
  errors=$((errors + 1))
else
  echo "PASS: no token canary when unconfigured (init unchanged)"
fi

# ---------------------------------------------------------------------------
# L3 — genuinely-unknown key → loader REJECTS (schema gate intact)
# ---------------------------------------------------------------------------
echo "--- L3: loader still rejects a genuinely-unknown config key ---"
plugin_config_patch "{\"zzE2eUnknownKey2945\": \"x\"}" ""
OUT_L3="$(install_and_capture)"
if printf '%s' "$OUT_L3" | grep -q "must NOT have additional properties"; then
  echo "PASS: loader rejected the unknown key (additionalProperties gate intact)"
else
  echo "FAIL: loader did not reject the unknown key — schema gate loosened?"
  printf '%s\n' "$OUT_L3" | tail -8 | sed 's/^/      /'
  errors=$((errors + 1))
fi
if printf '%s' "$OUT_L3" | grep -qE "Registered [0-9]+ agent-callable tools"; then
  echo "FAIL: plugin registered despite invalid config"
  errors=$((errors + 1))
else
  echo "PASS: plugin did not register with invalid config"
fi
plugin_config_patch "" "zzE2eUnknownKey2945"

# ---------------------------------------------------------------------------
# Token legs. Require: DB read-back + a token the platform validates.
# ---------------------------------------------------------------------------
DB_URL="${AXONFLOW_E2E_DB_URL:-}"
if [ -z "$DB_URL" ] || ! command -v psql >/dev/null 2>&1; then
  echo "SKIP: legs L4-L6 need AXONFLOW_E2E_DB_URL + psql for audit_logs read-back"
  if [ "$errors" -ne 0 ]; then echo "FAILED: $errors error(s)"; exit 1; fi
  echo "user-token runtime E2E: loader legs L1-L3 passed (token legs skipped)"
  exit 0
fi
query() { psql "$DB_URL" -tAc "$1" 2>/dev/null; }
wait_count() {
  local sql="$1" min="$2" n=0 c=0
  while [ "$n" -lt 30 ]; do
    c=$(query "$sql"); c="${c:-0}"
    [ "$c" -ge "$min" ] && break
    n=$((n + 1)); sleep 1
  done
  printf '%s' "$c"
}

# Capability probe — the platform must VALIDATE X-User-Token (reject garbage
# with 401) for legs 4-5 to prove anything.
BASIC_AUTH="$(printf '%s:%s' "$AXONFLOW_CLIENT_ID" "$AXONFLOW_CLIENT_SECRET" | base64 | tr -d '\n')"
PROBE_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -X POST "$AXONFLOW_ENDPOINT/api/v1/mcp-server" \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -H "Authorization: Basic $BASIC_AUTH" \
  -H "X-User-Token: e2e-garbage-token-probe" \
  -d '{"jsonrpc":"2.0","id":"probe","method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"probe","version":"0"}}}')
if [ "$PROBE_CODE" != "401" ]; then
  echo "SKIP: platform at $AXONFLOW_ENDPOINT does not validate X-User-Token (probe HTTP $PROBE_CODE; needs enterprise#2929+) — legs L4-L5 skipped."
  if [ "$errors" -ne 0 ]; then echo "FAILED: $errors error(s)"; exit 1; fi
  echo "user-token runtime E2E: loader legs passed (token legs skipped: platform pre-#2929)"
  exit 0
fi
echo "--- Platform validates X-User-Token (probe HTTP 401) — running token legs ---"

# Resolve a REAL token: operator-supplied, else self-sign with the agent's
# JWT_SECRET using the exact mint-API claims contract. Full platform-side
# validation applies either way.
TOKEN="${AXONFLOW_E2E_USER_TOKEN:-}"
TOKEN_EMAIL="${AXONFLOW_E2E_USER_TOKEN_EMAIL:-}"
if [ -z "$TOKEN" ]; then
  if [ -z "${AXONFLOW_E2E_JWT_SECRET:-}" ] || [ -z "${AXONFLOW_E2E_ORG_ID:-}" ]; then
    echo "SKIP: no minted token (set AXONFLOW_E2E_USER_TOKEN+AXONFLOW_E2E_USER_TOKEN_EMAIL, or AXONFLOW_E2E_JWT_SECRET+AXONFLOW_E2E_ORG_ID) — legs L4-L5 skipped."
    if [ "$errors" -ne 0 ]; then echo "FAILED: $errors error(s)"; exit 1; fi
    exit 0
  fi
  TOKEN_EMAIL="e2e-openclaw-token-dev-$(date +%s)-$RANDOM@example.com"
  TOKEN=$(TOKEN_EMAIL="$TOKEN_EMAIL" ORG_ID="$AXONFLOW_E2E_ORG_ID" JWT_SECRET="$AXONFLOW_E2E_JWT_SECRET" python3 - <<'PY'
import base64, hashlib, hmac, json, os, time, uuid
def b64url(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
header = {"alg": "HS256", "typ": "JWT"}
now = int(time.time())
claims = {
    "iss": "axonflow-user-token-mint",
    "email": os.environ["TOKEN_EMAIL"],
    "role": "developer",
    "org_id": os.environ["ORG_ID"],
    "jti": str(uuid.uuid4()),
    "iat": now,
    "exp": now + 3600,
}
signing_input = b64url(json.dumps(header, separators=(",", ":")).encode()) + "." + \
    b64url(json.dumps(claims, separators=(",", ":")).encode())
sig = hmac.new(os.environ["JWT_SECRET"].encode(), signing_input.encode(), hashlib.sha256).digest()
print(signing_input + "." + b64url(sig))
PY
)
  [ -n "$TOKEN" ] || { echo "FAIL: could not sign a mint-contract token"; exit 1; }
fi
if [ -z "$TOKEN_EMAIL" ]; then
  echo "SKIP: AXONFLOW_E2E_USER_TOKEN set without AXONFLOW_E2E_USER_TOKEN_EMAIL — legs L4-L5 skipped."
  if [ "$errors" -ne 0 ]; then echo "FAILED: $errors error(s)"; exit 1; fi
  exit 0
fi
# The platform canonicalizes (lowercase+trim) the token email.
TOKEN_EMAIL_CANON=$(printf '%s' "$TOKEN_EMAIL" | tr '[:upper:]' '[:lower:]')

# Plane note (verified against the 9.9.0 platform): the token travels as the
# X-User-Token HEADER on every governed request (baseHeaders()). The planes
# that CONSUME it today are the MCP-server plane (/api/v1/mcp-server — the 15
# MCP tools behind the agent tools; Basic carries the tenant, the header the
# user) and the agent-PROXIED REST plane (/api/v1/audit/*, /api/v1/decisions,
# /api/v1/overrides — platform/agent/proxy.go resolves the header fail-closed
# and the VALIDATED identity overrides any X-User-Email label). The
# /api/v1/mcp/check-input|check-output plane reads a per-user token from the
# request BODY (`user_token`, the legacy tenant-JWT contract) and ignores the
# header — rows there keep the client-scoped identity. So the attribution
# assertions below key on the tool_call_audit rows (proxied plane), and the
# accept/deny assertions on the MCP-server plane via the agent tool.
drive_agent_turn() {
  # $1 = output file. One governed agent turn that exercises the planes:
  # before_tool_call → /api/v1/mcp/check-input (hook plane),
  # axonflow_audit_search → /api/v1/mcp-server tools/call (agent-tool plane),
  # after_tool_call → proxied /api/v1/audit/tool-call (attribution plane).
  local out="$1"
  env -u AXONFLOW_USER_TOKEN timeout 180 openclaw agent \
    --local --agent main --model "$OPENCLAW_E2E_MODEL" \
    --message "Use the axonflow_audit_search tool with limit=5 to fetch recent audit events. Then output exactly the literal text SMOKE_RESULT: followed by {\"tool_succeeded\":true} if the tool returned audit data, or {\"tool_succeeded\":false} if the tool was blocked or errored." \
    --json --thinking off >"$out" 2>/dev/null || true
}

# Extract .tool_succeeded from the SMOKE_RESULT line as the string
# "true"/"false"/"" — deliberately NOT `// empty`, which swallows a literal
# `false` (jq's // treats false like null).
smoke_tool_succeeded() {
  jq -r '.payloads[]?.text // empty' "$1" 2>/dev/null \
    | grep -E "SMOKE_RESULT:" | tail -1 | sed 's/.*SMOKE_RESULT: *//' \
    | jq -r 'if has("tool_succeeded") then (.tool_succeeded | tostring) else "" end' 2>/dev/null
}

# ---------------------------------------------------------------------------
# L4 — valid token + FORGED userEmail → token's validated identity wins
# ---------------------------------------------------------------------------
FORGED="forged-label-$(date +%s)@example.com"
echo "--- L4: validated token identity beats forged userEmail (token=$TOKEN_EMAIL_CANON, forged=$FORGED) ---"
# Baseline BEFORE the turn: with an operator-supplied (reused) token email,
# rows from a previous run would satisfy a bare count>=1 — assert the DELTA.
ROWS_TOKEN_BASE=$(query "SELECT count(*) FROM audit_logs WHERE user_email='$TOKEN_EMAIL_CANON';")
ROWS_TOKEN_BASE="${ROWS_TOKEN_BASE:-0}"
plugin_config_patch "{\"userToken\": \"$TOKEN\", \"userEmail\": \"$FORGED\", \"endpoint\": \"$AXONFLOW_ENDPOINT\", \"clientId\": \"$AXONFLOW_CLIENT_ID\", \"clientSecret\": \"$AXONFLOW_CLIENT_SECRET\", \"onError\": \"block\"}" ""
OUT_L4=$(mktemp -t axonflow-user-token-l4.XXXXXX)
drive_agent_turn "$OUT_L4"

# Positive gate on the MCP-server plane: a VALID token must be ACCEPTED
# (the paired negative is L5's tampered-token deny — together they prove the
# header value, not something else, drives the verdict).
TOOL_OK_L4=$(smoke_tool_succeeded "$OUT_L4")
if [ "$TOOL_OK_L4" = "true" ]; then
  echo "PASS: MCP-server plane accepted the valid token (audit-search tool returned data)"
else
  echo "FAIL: audit-search tool did not succeed with a VALID token (got: '${TOOL_OK_L4:-no smoke}')"
  jq -r '.payloads[]?.text // empty' "$OUT_L4" 2>/dev/null | head -3 | sed 's/^/      /'
  errors=$((errors + 1))
fi

ROWS_TOKEN=$(wait_count "SELECT count(*) FROM audit_logs WHERE user_email='$TOKEN_EMAIL_CANON';" $((ROWS_TOKEN_BASE + 1)))
if [ "${ROWS_TOKEN:-0}" -ge $((ROWS_TOKEN_BASE + 1)) ]; then
  echo "PASS: audit_logs rows attribute to the token's validated email (+$((ROWS_TOKEN - ROWS_TOKEN_BASE)) row(s) this run)"
else
  echo "FAIL: no NEW audit_logs row attributed to $TOKEN_EMAIL_CANON this run (baseline=$ROWS_TOKEN_BASE, now=${ROWS_TOKEN:-0})"
  jq -r '.payloads[]?.text // empty' "$OUT_L4" 2>/dev/null | head -3 | sed 's/^/      /'
  errors=$((errors + 1))
fi
ROWS_FORGED=$(query "SELECT count(*) FROM audit_logs WHERE user_email='$FORGED';")
if [ "${ROWS_FORGED:-0}" -eq 0 ]; then
  echo "PASS: forged userEmail label attributed ZERO rows while the token was present"
else
  echo "FAIL: $ROWS_FORGED row(s) attributed to the forged label $FORGED despite a valid token"
  errors=$((errors + 1))
fi
echo "--- audit_logs attribution sample (token identity) ---"
query "SELECT request_type, user_email FROM audit_logs WHERE user_email='$TOKEN_EMAIL_CANON' ORDER BY timestamp DESC LIMIT 5;" || true
rm -f "$OUT_L4"

# ---------------------------------------------------------------------------
# L5 — tampered token → governed call BLOCKED (fail-closed), no token leak
# ---------------------------------------------------------------------------
echo "--- L5: tampered token fail-closed ---"
# Flip the FIRST signature character (the last char can be base64 padding
# bits — flipping it may leave the decoded bytes unchanged and still verify).
SIG="${TOKEN##*.}"
BODY="${TOKEN%.*}"
case "$SIG" in
  x*) TAMPERED="$BODY.A${SIG#?}" ;;
  *)  TAMPERED="$BODY.x${SIG#?}" ;;
esac
plugin_config_patch "{\"userToken\": \"$TAMPERED\"}" ""
OUT_L5=$(mktemp -t axonflow-user-token-l5.XXXXXX)
MARKER_L5="tamper-leg-$(date +%s)-$RANDOM"
env -u AXONFLOW_USER_TOKEN timeout 180 openclaw agent \
  --local --agent main --model "$OPENCLAW_E2E_MODEL" \
  --message "Use the axonflow_audit_search tool with limit=5 to fetch recent audit events mentioning $MARKER_L5. Then output exactly the literal text SMOKE_RESULT: followed by {\"tool_succeeded\":true} if the tool returned audit data, or {\"tool_succeeded\":false} if the tool was blocked or errored." \
  --json --thinking off >"$OUT_L5" 2>/dev/null || true

SMOKE_L5=$(jq -r '.payloads[]?.text // empty' "$OUT_L5" 2>/dev/null | grep -E "SMOKE_RESULT:" | tail -1 | sed 's/.*SMOKE_RESULT: *//')
TOOL_OK=$(smoke_tool_succeeded "$OUT_L5")
if [ "$TOOL_OK" = "false" ]; then
  echo "PASS: tampered token → governed tool blocked/errored (fail-closed, no silent fall-open)"
elif [ -z "$SMOKE_L5" ]; then
  # The block can also surface as the agent turn erroring out before a
  # SMOKE_RESULT is produced — accept, but require the deny evidence below.
  if grep -qiE "blocked|auth error|401|unauthorized" "$OUT_L5"; then
    echo "PASS: tampered token → agent output shows the governed call was denied"
  else
    echo "FAIL: no SMOKE_RESULT and no deny evidence in agent output with a tampered token"
    head -c 400 "$OUT_L5" | sed 's/^/      /'; echo ""
    errors=$((errors + 1))
  fi
else
  echo "FAIL: governed tool reported success with a TAMPERED token: $SMOKE_L5"
  errors=$((errors + 1))
fi
if grep -qF "$TAMPERED" "$OUT_L5"; then
  echo "FAIL: agent output leaked the tampered token value"
  errors=$((errors + 1))
else
  echo "PASS: agent output does not leak the token value"
fi
rm -f "$OUT_L5"

# ---------------------------------------------------------------------------
# L6 — unconfigured → label-path attribution unchanged (pre-2.7.0 behavior)
# ---------------------------------------------------------------------------
LABEL6="e2e-notoken-label-$(date +%s)@example.com"
echo "--- L6: unconfigured token — label path unchanged (userEmail=$LABEL6) ---"
plugin_config_patch "{\"userEmail\": \"$LABEL6\"}" "userToken"
OUT_L6=$(mktemp -t axonflow-user-token-l6.XXXXXX)
drive_agent_turn "$OUT_L6"
# Whether the label attributes rows depends on the platform's identity
# trust gate (AXONFLOW_TRUST_IDENTITY_HEADERS) — the invariant that is OURS
# to prove is that governed traffic still flows with no token configured.
if jq -r '.payloads[]?.text // empty' "$OUT_L6" 2>/dev/null | grep -q "SMOKE_RESULT:"; then
  echo "PASS: governed agent turn completed with no token configured (no regression)"
else
  echo "FAIL: governed agent turn did not complete without a token"
  errors=$((errors + 1))
fi
rm -f "$OUT_L6"

echo ""
if [ "$errors" -ne 0 ]; then
  echo "FAILED: $errors error(s)"
  exit 1
fi
echo "user-token runtime E2E: ALL LEGS PASSED"
