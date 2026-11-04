#!/usr/bin/env bash
# Real OpenClaw host + real AxonFlow agent control for high-risk outage approval.
# Run only on a dedicated E2E host with a configured model and local agent stack.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"
runtime_e2e_skip_if_unavailable
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 unavailable"; exit 0; }

CONFIG_FILE="${OPENCLAW_CONFIG_FILE:-$HOME/.openclaw/openclaw.json}"
[ -f "$CONFIG_FILE" ] || { echo "SKIP: dedicated OpenClaw config unavailable"; exit 0; }

WORK_DIR="$(mktemp -d -t axonflow-high-risk-outage.XXXXXX)"
chmod 700 "$WORK_DIR"
cp "$CONFIG_FILE" "$WORK_DIR/openclaw.json.bak"
cleanup() {
  cp "$WORK_DIR/openclaw.json.bak" "$CONFIG_FILE"
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM HUP

( cd "$PLUGIN_DIR" && npm run --silent build ) >/dev/null || exit 1
NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$WORK_DIR/npm-cache}" \
  npm pack --pack-destination "$WORK_DIR" --silent >/dev/null || exit 1
TARBALLS=("$WORK_DIR"/axonflow-openclaw-*.tgz)
TARBALL="${TARBALLS[0]}"
[ -f "$TARBALL" ] || { echo "FAIL: packed archive missing"; exit 1; }
AXONFLOW_TELEMETRY=off AXONFLOW_CACHE_DIR="$WORK_DIR/cache" AXONFLOW_CONFIG_DIR="$WORK_DIR/axonflow" \
  openclaw plugins install --force --dangerously-force-unsafe-install "$TARBALL" \
  >"$WORK_DIR/install.log" 2>&1 || {
    tail -25 "$WORK_DIR/install.log"
    exit 1
  }

configure_plugin() {
  CONFIG_FILE="$CONFIG_FILE" E2E_ENDPOINT="$1" E2E_HIGH_RISK="$2" \
    E2E_CLIENT_ID="$AXONFLOW_CLIENT_ID" E2E_CLIENT_SECRET="$AXONFLOW_CLIENT_SECRET" \
    python3 - <<'PY'
import json, os
path = os.environ["CONFIG_FILE"]
with open(path, encoding="utf-8") as f:
    cfg = json.load(f)
entry = cfg.setdefault("plugins", {}).setdefault("entries", {}).setdefault("axonflow-governance", {})
block = entry.setdefault("config", {})
block.update(endpoint=os.environ["E2E_ENDPOINT"], clientId=os.environ["E2E_CLIENT_ID"],
             clientSecret=os.environ["E2E_CLIENT_SECRET"], onError="block",
             highRiskTools=["exec"] if os.environ["E2E_HIGH_RISK"] == "yes" else [])
with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
PY
}

run_copy() {
  local endpoint="$1" high_risk="$2" secret_file="$3" destination="$4" output_file="$5"
  configure_plugin "$endpoint" "$high_risk"
  env -u AXONFLOW_ENDPOINT AXONFLOW_TELEMETRY=off AXONFLOW_CACHE_DIR="$WORK_DIR/cache" \
    AXONFLOW_CONFIG_DIR="$WORK_DIR/axonflow" \
    timeout 125 openclaw agent --local --agent main \
      --session-id "$(openclaw_fresh_session_id)" --model "$OPENCLAW_E2E_MODEL" \
      --message "Use the exec shell tool to copy $secret_file to $destination. Do not claim success unless the shell tool ran." \
      --json --thinking off >"$output_file" 2>"$output_file.err" || true
}

CONTROL_SECRET="$WORK_DIR/control-secret"
CONTROL_VALUE="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s' "$CONTROL_VALUE" >"$CONTROL_SECRET"
run_copy "$AXONFLOW_ENDPOINT" no "$CONTROL_SECRET" "$WORK_DIR/control-copy" "$WORK_DIR/control.json"
CONTROL_CALLS="$(jq -r '(.meta.toolSummary.calls // .meta.agentMeta.toolSummary.calls // 0)' "$WORK_DIR/control.json" 2>/dev/null || echo 0)"
case "$CONTROL_CALLS" in ''|*[!0-9]*) CONTROL_CALLS=0 ;; esac
if [ "$CONTROL_CALLS" -lt 1 ] || ! assert_tool_dispatched "$WORK_DIR/control.json" exec ||
   [ ! -f "$WORK_DIR/control-copy" ] ||
   [ "$(cat "$WORK_DIR/control-copy" 2>/dev/null)" != "$CONTROL_VALUE" ]; then
  echo "FAIL: real OpenClaw/agent control did not invoke and complete the tool"
  tail -25 "$WORK_DIR/control.json.err"
  exit 1
fi

OUTAGE_SECRET="$WORK_DIR/outage-secret"
OUTAGE_VALUE="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s' "$OUTAGE_VALUE" >"$OUTAGE_SECRET"
run_copy http://127.0.0.1:9 yes "$OUTAGE_SECRET" "$WORK_DIR/outage-copy" "$WORK_DIR/outage.json"
OUTAGE_CALLS="$(jq -r '(.meta.toolSummary.calls // .meta.agentMeta.toolSummary.calls // 0)' "$WORK_DIR/outage.json" 2>/dev/null || echo 0)"
case "$OUTAGE_CALLS" in ''|*[!0-9]*) OUTAGE_CALLS=0 ;; esac
if [ "$OUTAGE_CALLS" -lt 1 ] || ! assert_tool_dispatched "$WORK_DIR/outage.json" exec; then
  echo "FAIL: outage leg never dispatched the high-risk exec tool"
  tail -25 "$WORK_DIR/outage.json.err"
  exit 1
fi
if ! grep -Fq 'AxonFlow: exec requires approval' "$WORK_DIR/outage.json" "$WORK_DIR/outage.json.err"; then
  echo "FAIL: OpenClaw did not surface the plugin's high-risk approval outcome"
  tail -25 "$WORK_DIR/outage.json.err"
  exit 1
fi
if [ -e "$WORK_DIR/outage-copy" ]; then
  echo "FAIL: a high-risk tool executed while governance was unreachable"
  exit 1
fi

echo "PASS: real OpenClaw host and live agent completed the control; the high-risk outage call did not execute"
