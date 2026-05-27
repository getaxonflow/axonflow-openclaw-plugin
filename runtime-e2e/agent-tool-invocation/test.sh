#!/usr/bin/env bash
# OpenClaw runtime E2E: agent can SEE and CALL axonflow tools
#
# The agent-tools-registration test proves tools are in the buildAgentTools()
# array via direct Node import. This test proves they survive the OpenClaw
# plugin host's contract filtering and actually reach the LLM.
#
# v2.6.4 incident: 11 tools registered but invisible because contracts.tools
# was missing from openclaw.plugin.json. This test would have caught it.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

# Skip if no LLM key available (this test needs a real model call).
# Accept either explicit env var OR openclaw's auth-profile keychain
# (which surfaces as "read anthropic credentials from claude cli keychain"
# at agent startup).
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  # Try a dry-run agent invocation to see if any auth profile is configured.
  # If no provider key exists at all, openclaw exits with a FailoverError.
  if ! timeout 15 openclaw agent --local --model anthropic/claude-haiku-4-5 \
       --message "hi" --json --session-id __auth-probe-$$ 2>&1 | grep -q '"payloads"'; then
    echo "SKIP: no LLM API key available (set ANTHROPIC_API_KEY or authenticate openclaw)"
    exit 0
  fi
fi

if ! command -v openclaw >/dev/null 2>&1; then
  echo "SKIP: openclaw CLI not on PATH"
  exit 0
fi

echo "--- Building + installing local OpenClaw plugin ---"
openclaw_install_local_plugin || exit 1

# Step 1: Verify doctor is clean
echo "--- Checking plugins doctor ---"
DOCTOR_OUT=$(openclaw plugins doctor 2>&1 || true)
if echo "$DOCTOR_OUT" | grep -q "axonflow-governance.*contracts\.tools\|contracts\.tools.*axonflow-governance"; then
  echo "FAIL: plugins doctor reports contracts.tools issue"
  echo "$DOCTOR_OUT" | grep "axonflow-governance"
  exit 1
fi
if echo "$DOCTOR_OUT" | grep -q "axonflow-governance.*must declare"; then
  echo "FAIL: plugins doctor reports missing declaration"
  echo "$DOCTOR_OUT" | grep "axonflow-governance"
  exit 1
fi
echo "PASS: plugins doctor clean"

# Step 2: Call axonflow_get_tenant_id through the agent
echo "--- Calling axonflow_get_tenant_id through openclaw agent ---"
OUTPUT_FILE=$(mktemp -t axonflow-tool-invoke.XXXXXX)
cleanup() { rm -f "$OUTPUT_FILE"; }
trap cleanup EXIT

AXONFLOW_TELEMETRY=off openclaw_agent_capture \
  "Call the axonflow_get_tenant_id tool. Output only the raw tool result, nothing else." \
  "$OUTPUT_FILE"

REPLY=$(jq -r '.payloads[0].text // ""' "$OUTPUT_FILE" 2>/dev/null)

errors=0

# The reply must NOT contain "tool not found" / "don't see" / "not available"
if echo "$REPLY" | grep -qiE "not (found|available|see)|don.t (see|have|find)|no .* tool|unknown tool"; then
  echo "FAIL: agent could not find axonflow_get_tenant_id tool"
  echo "  Reply: $(echo "$REPLY" | head -3)"
  errors=$((errors + 1))
fi

# The reply must contain a tenant ID or "tier" or "endpoint" — evidence the tool ran
if echo "$REPLY" | grep -qiE "cs_[0-9a-f-]+|tenant.id|tier.*free|endpoint.*getaxonflow|upgrade.*url"; then
  echo "PASS: agent called axonflow_get_tenant_id and got a real response"
else
  echo "FAIL: agent reply does not contain expected tenant/status fields"
  echo "  Reply: $(echo "$REPLY" | head -5)"
  errors=$((errors + 1))
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAIL: $errors assertion(s) failed"
  exit 1
fi

echo ""
echo "PASS: agent-tool-invocation (tool visible + callable + returned real data)"
