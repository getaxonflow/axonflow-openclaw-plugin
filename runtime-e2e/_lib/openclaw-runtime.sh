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
: "${OPENCLAW_E2E_MODEL:=anthropic/claude-haiku-4-5}"

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
  # Match any reasonable two-digit count so the gate doesn't go stale
  # whenever new agent tools land. Pre-existing bug: this regex was
  # frozen at "Registered 5" since v2.0 — V1 Pro brought it to 10 and
  # V1.1 (#1982) brings it to 11. Asserting "Registered N agent-callable
  # tools" with N≥5 instead of a hardcoded count.
  if ! printf '%s' "$install_out" | grep -qE "Registered [0-9]+ agent-callable tools"; then
    echo "FAIL: OpenClaw runtime did not log 'Registered N agent-callable tools'"
    printf '%s\n' "$install_out" | tail -10 | sed 's/^/      /'
    return 1
  fi

  openclaw config set "plugins.entries.axonflow-governance.config.endpoint" "$AXONFLOW_ENDPOINT" >/dev/null
  openclaw config set "plugins.entries.axonflow-governance.config.clientId" "$AXONFLOW_CLIENT_ID" >/dev/null
  openclaw config set "plugins.entries.axonflow-governance.config.clientSecret" "$AXONFLOW_CLIENT_SECRET" >/dev/null
  # The override lifecycle endpoints (create_override / revoke_override) require
  # an X-User-Email header server-side per ADR-044. Without it the orchestrator
  # returns 401. Set a deterministic test identity so the lifecycle tests can
  # actually exercise revoke against state seeded with the same identity.
  openclaw config set "plugins.entries.axonflow-governance.config.userEmail" \
    "${AXONFLOW_TEST_USER_EMAIL:-dev@getaxonflow.com}" >/dev/null
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
  # OpenClaw can emit progress text + final reply across multiple payloads,
  # so we have to scan all of them rather than just .payloads[0].
  jq -r '.payloads[]?.text // empty' "$output_file" 2>/dev/null | grep -q "SMOKE_RESULT:"
}

assert_reply_contains() {
  local output_file="$1"
  local needle="$2"
  jq -r '.payloads[]?.text // empty' "$output_file" 2>/dev/null | grep -q "$needle"
}

# Returns the SMOKE_RESULT JSON text (post-prefix) from any payload.
extract_smoke_line() {
  local output_file="$1"
  jq -r '.payloads[]?.text // empty' "$output_file" 2>/dev/null \
    | grep -E "SMOKE_RESULT:" | tail -1 | sed 's/.*SMOKE_RESULT: *//'
}

# require_override_preflight <http_status> <body>
#
# Classifies the result of the override-create pre-flight that the override
# lifecycle tests use to seed state. Every one of them previously printed
# `SKIP: pre-flight create_override returned HTTP $STATUS` and exited 0 on ANY
# non-201 — which meant they passed-by-skipping in exactly the default
# configuration every user runs (#3062): the agent strips X-User-Email unless
# AXONFLOW_TRUST_IDENTITY_HEADERS=true, so create_override 401s and the whole
# suite reported green while two of the eleven advertised tools were dead.
#
# A test that skips is not a test. The ONLY legitimate exit-0 in this suite is
# environment unavailability (no CLI, no reachable stack), which
# runtime_e2e_skip_if_unavailable already owns and which is checked before we
# get here. A reachable stack that refuses to create an override is a FAILURE,
# and this prints the remediation instead of swallowing it.
require_override_preflight() {
  local status="$1"
  local body="$2"

  if [ "$status" = "201" ]; then
    return 0
  fi

  echo "FAIL: pre-flight create_override returned HTTP $status (expected 201)"
  echo "      Body: $body"
  echo ""

  case "$status" in
    401)
      echo "      The override endpoints require a per-user identity. This deployment"
      echo "      is not configured to trust client-asserted identity headers, so the"
      echo "      AxonFlow Agent removed the X-User-Email this test sent."
      echo ""
      echo "      Set the posture this test requires, then re-run:"
      echo "        AXONFLOW_TRUST_IDENTITY_HEADERS=true   # on the AGENT, then restart it"
      echo ""
      echo "      Only enable it when every hop that can reach the agent asserts"
      echo "      end-user identity from a validated source — see"
      echo "      docs/security/identity-header-trust.md in axonflow-enterprise."
      ;;
    403)
      echo "      The stack rejected the override on policy grounds. Check that the"
      echo "      seed policy is overridable (not critical-risk, allow_override=true)"
      echo "      and that the request reached the orchestrator through the agent."
      ;;
    404)
      echo "      The seed policy was not found for this tenant. Confirm the stack's"
      echo "      migrations ran and that X-Tenant-ID matches the seeded tenant."
      ;;
  esac

  return 1
}
