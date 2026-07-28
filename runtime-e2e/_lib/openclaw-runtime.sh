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

# Assert the stack can actually create an override, or FAIL naming what is
# missing (#167, axonflow-enterprise#3062).
#
# The override endpoints need a per-user identity, and since platform 9.9.0 the
# agent ignores X-User-Email unless the identity trust gate is explicitly on —
# so a healthy-looking default stack answers 401 here. Three suites used to
# print "SKIP:" and exit 0 on that, which meant CI reported success in exactly
# the configuration every user runs and the behaviour under test never ran.
#
# The posture is a server-side setting on the AxonFlow agent, not a plugin or
# request-level knob, so it cannot be provisioned from this harness. The only
# honest outcome is a failure that names it. Callers must invoke this INSTEAD OF
# rolling their own probe, so the next suite to need one cannot reintroduce the
# skip.
#
# Usage: require_override_preflight <policy_id> [ttl_seconds]
# Echoes nothing on success; exits 1 with a diagnostic on anything but 201.
require_override_preflight() {
  local policy_id="${1:-sys_pii_email}" ttl="${2:-60}"
  local auth_hdr response status body probe_id
  auth_hdr="Authorization: Basic $(printf '%s:%s' "$AXONFLOW_CLIENT_ID" "$AXONFLOW_CLIENT_SECRET" | base64)"

  response=$(curl -s -X POST \
    -H "$auth_hdr" \
    -H "Content-Type: application/json" \
    -H "X-Tenant-ID: local-dev-org" \
    -H "X-User-Email: ${AXONFLOW_TEST_USER_EMAIL:-dev@getaxonflow.com}" \
    -d "{\"policy_id\":\"$policy_id\",\"policy_type\":\"static\",\"override_reason\":\"preflight-posture-probe\",\"ttl_seconds\":$ttl}" \
    -w "\nHTTP_STATUS:%{http_code}" \
    "$AXONFLOW_ENDPOINT/api/v1/overrides")
  status=$(printf '%s' "$response" | sed -n 's/^HTTP_STATUS://p')
  body=$(printf '%s' "$response" | sed '$d')

  if [ "$status" = "201" ]; then
    probe_id=$(printf '%s' "$body" | jq -r '.id // empty')
    if [ -n "$probe_id" ]; then
      curl -s -X DELETE \
        -H "$auth_hdr" \
        -H "X-Tenant-ID: local-dev-org" \
        -H "X-User-Email: ${AXONFLOW_TEST_USER_EMAIL:-dev@getaxonflow.com}" \
        "$AXONFLOW_ENDPOINT/api/v1/overrides/$probe_id" >/dev/null
    fi
    echo "--- Pre-flight: override posture confirmed (HTTP 201) ---"
    return 0
  fi

  echo "FAIL: pre-flight create_override returned HTTP $status (expected 201)"
  echo "      Endpoint: $AXONFLOW_ENDPOINT"
  echo "      Policy:   $policy_id"
  echo "      Body:     $body"
  echo ""
  echo "      The override lifecycle endpoints require a per-user identity."
  echo "      Since platform 9.9.0 the agent ignores X-User-Email unless the"
  echo "      identity trust gate is explicitly enabled, so an otherwise"
  echo "      healthy stack answers 401 here. Enable it on the AGENT and"
  echo "      restart it:"
  echo ""
  echo "          AXONFLOW_TRUST_IDENTITY_HEADERS=true"
  echo ""
  echo "      Then re-run this test. See axonflow-enterprise#3062 for the"
  echo "      platform-side work making this 401 self-explanatory."
  echo ""
  echo "      This test does NOT skip on a missing posture: a test that"
  echo "      exits 0 without exercising its subject is not a test."
  exit 1
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
