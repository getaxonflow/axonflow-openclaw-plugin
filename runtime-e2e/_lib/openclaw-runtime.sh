#!/usr/bin/env bash
# Shared helpers for OpenClaw runtime-e2e tests.
#
# Each per-feature test sources this file. Helpers handle plugin
# install, point the plugin at the local stack, drive `openclaw agent
# --local` non-interactively with --json output, and parse the agent's
# `payloads[0].text` reply for the SMOKE_RESULT marker + tool-name
# evidence.
#
# OpenClaw's --json output puts the agent's text reply at
# .payloads[0].text, plus a structured .meta.toolSummary that lists the
# tools actually invoked. We use both: toolSummary is the strongest
# evidence, payloads[0].text is the user-visible reply.

set -uo pipefail

: "${AXONFLOW_ENDPOINT:=http://localhost:8080}"
: "${AXONFLOW_CLIENT_ID:=demo-client}"
: "${AXONFLOW_CLIENT_SECRET:=demo-secret}"
: "${OPENCLAW_E2E_MODEL:=openai-codex/gpt-5.5}"

runtime_e2e_skip_if_unavailable() {
  if ! command -v openclaw >/dev/null 2>&1; then
    echo "SKIP: openclaw CLI not on PATH"
    exit 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "SKIP: jq not on PATH"
    exit 0
  fi
  if ! curl -sSf -o /dev/null --max-time 5 "$AXONFLOW_ENDPOINT/health"; then
    echo "SKIP: AxonFlow stack not reachable at $AXONFLOW_ENDPOINT/health"
    echo "      Start one via axonflow-enterprise scripts/setup-e2e-testing.sh"
    exit 0
  fi
}

# Install the local plugin build into OpenClaw's extension directory.
# Idempotent: --force overwrites; --dangerously-force-unsafe-install
# bypasses the dangerous-code scan that flags scripts/ helpers.
openclaw_install_local_plugin() {
  local plugin_dir
  plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

  ( cd "$plugin_dir" && npm run --silent build ) >/dev/null 2>&1 || {
    echo "FAIL: plugin build failed in $plugin_dir"
    return 1
  }

  local install_out
  install_out=$(cd "$plugin_dir" && openclaw plugins install --force --dangerously-force-unsafe-install . 2>&1)
  if ! printf '%s' "$install_out" | grep -q "Registered 5 agent-callable tools"; then
    echo "FAIL: OpenClaw runtime did not log 'Registered 5 agent-callable tools'"
    printf '%s\n' "$install_out" | tail -10 | sed 's/^/      /'
    return 1
  fi

  openclaw config set "plugins.entries.axonflow-governance.config.endpoint" "$AXONFLOW_ENDPOINT" >/dev/null
  openclaw config set "plugins.entries.axonflow-governance.config.clientId" "$AXONFLOW_CLIENT_ID" >/dev/null
  openclaw config set "plugins.entries.axonflow-governance.config.clientSecret" "$AXONFLOW_CLIENT_SECRET" >/dev/null
}

# Run a single agent turn against the local OpenClaw runtime.
openclaw_agent_capture() {
  local prompt="$1"
  local output_file="$2"
  timeout 180 openclaw agent \
    --local \
    --agent main \
    --model "$OPENCLAW_E2E_MODEL" \
    --message "$prompt" \
    --json \
    --thinking off \
    >"$output_file" 2>/dev/null || true
}

assert_tool_in_summary() {
  local output_file="$1"
  local tool_name="$2"
  jq -e --arg t "$tool_name" '.meta.agentMeta // {}' "$output_file" >/dev/null 2>&1
  # toolSummary lives at multiple paths across openclaw versions; check
  # both `.meta.toolSummary` (older) and the agent reply text (always).
  jq -e --arg t "$tool_name" \
    '(.meta.toolSummary.tools // [] | index($t) != null)
     or (.meta.agentMeta.toolSummary.tools // [] | index($t) != null)
     or (.payloads[0].text // "" | contains($t))' \
    "$output_file" >/dev/null 2>&1
}

assert_smoke_result() {
  local output_file="$1"
  jq -r '.payloads[0].text // empty' "$output_file" 2>/dev/null | grep -q "SMOKE_RESULT:"
}

assert_reply_contains() {
  local output_file="$1"
  local needle="$2"
  jq -r '.payloads[0].text // empty' "$output_file" 2>/dev/null | grep -q "$needle"
}
