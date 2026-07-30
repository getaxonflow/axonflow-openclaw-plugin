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
  # A validated per-user token, when the harness has one, must reach the plugin
  # through pluginConfig rather than only through the driver shell's environment.
  # The plugin resolves userToken as pluginConfig > AXONFLOW_USER_TOKEN env >
  # provisioning file, so an env-only value works when the suite is run from a
  # shell that exports it and silently does not when it isn't — which makes
  # every read-scope assertion depend on the invoker rather than on the suite.
  # Setting it here means the plugin and the suites' own probes present the same
  # identity to the platform.
  if [ -n "${AXONFLOW_USER_TOKEN:-}" ]; then
    openclaw config set "plugins.entries.axonflow-governance.config.userToken" \
      "$AXONFLOW_USER_TOKEN" >/dev/null
  fi
}

# Populate AUDIT_READ_IDENTITY_ARGS with the curl args carrying the identity the
# PLUGIN sends on a governed read. An array, not command substitution: a header
# value contains a space, so `$(...)` word-splitting would send `-HX-User-Token:`
# (a header with an empty value) and pass the token itself as a URL — which
# fails as "no rows" rather than as an error, i.e. the exact silent-wrong-answer
# shape this helper exists to remove.
AUDIT_READ_IDENTITY_ARGS=()
set_audit_read_identity_args() {
  AUDIT_READ_IDENTITY_ARGS=()
  if [ -n "${AXONFLOW_USER_TOKEN:-}" ]; then
    AUDIT_READ_IDENTITY_ARGS+=(-H "X-User-Token: $AXONFLOW_USER_TOKEN")
  fi
}

# require_audit_read_scope <marker> <audit-search-response> <read-scope-header>
#
# Called when a seeded marker is not visible through /api/v1/audit/search. Names
# the actual cause and prints a remedy that can work, then the caller exits
# non-zero. Never exits 0: a suite that cannot see the audit trail it just wrote
# has found something, and "skip" reported that as success until #167.
#
# The read scope is READ FROM THE PLATFORM, not inferred from `entries == 0`.
# Since 9.10.0 these routes stamp an `X-Axonflow-Read-Scope` response header
# ("none" / "own-rows" / "tenant") whose documented purpose is exactly this:
# distinguishing "you cannot see it" from "the data is gone". Inferring it from
# an empty array reaches the same conclusion by guessing, and gets it wrong
# whenever the array is empty for some other reason -- a window that excludes the
# row, for one.
#
# WHY THE REMEDY IS "an admin-class token" and not "a token":
# the rows this suite seeds come from a check-input call authenticated with the
# SHARED client credential, so the platform attributes them to the synthetic pool
# identity <client-id>@axonflow.local with role `service` -- not to whoever holds
# the per-user token. A `developer`-role token therefore resolves to `own-rows`,
# which does not include them, and no amount of re-minting a developer token can
# ever make this suite pass. Only a role resolving to `tenant` (admin / owner /
# policy_admin) can read them. Measured on 9.13.0: developer token ->
# `X-Axonflow-Read-Scope: own-rows`, total 0; admin token -> `tenant`, total 95.
require_audit_read_scope() {
  local marker="$1" response="$2" read_scope="${3:-}"
  local total entries
  total=$(printf '%s' "$response" | jq -r '.total // "?"' 2>/dev/null)
  entries=$(printf '%s' "$response" | jq -r '.entries | length' 2>/dev/null)

  echo "FAIL: the seeded marker never landed in the audit log"
  echo "      marker:   $marker"
  echo "      endpoint: $AXONFLOW_ENDPOINT"
  echo "      audit/search returned total=$total entries=${entries:-?}"
  echo "      X-Axonflow-Read-Scope: ${read_scope:-<absent>}"
  if [ -n "${AXONFLOW_USER_TOKEN:-}" ]; then
    echo "      identity sent: X-User-Token (configured)"
  else
    echo "      identity sent: shared client credential only (no per-user token)"
  fi
  echo ""

  # Branch on the scope the PLATFORM reported. `none` and `own-rows` are both
  # "this credential cannot read the seeded rows" and need the same remedy;
  # `tenant` means the read was wide enough, so the marker's absence is a real
  # window / write / search / catalogue finding.
  case "$read_scope" in
    none|own-rows)
      echo "      The platform reports this caller's read scope as '$read_scope',"
      echo "      so this is an AUTHORIZATION result, not a statement about the"
      echo "      marker."
      echo ""
      echo "      The rows this suite seeds are written under the shared client"
      echo "      credential, so the platform attributes them to the synthetic"
      echo "      pool identity <client-id>@axonflow.local with role 'service'."
      echo "      A 'developer'-role token resolves to 'own-rows', which does NOT"
      echo "      include them -- re-minting a developer token cannot fix this."
      echo "      Provide a token whose role resolves to tenant-wide reads"
      echo "      (admin / owner / policy_admin):"
      echo "        AXONFLOW_USER_TOKEN=<admin-class token>   # sent as X-User-Token"
      echo "      See the AXONFLOW_USER_TOKEN entry in openclaw.plugin.json."
      ;;
    tenant)
      echo "      The read scope was 'tenant', so the search WAS wide enough and"
      echo "      the marker is genuinely absent from what came back."
      if [ "${entries:-0}" = "0" ]; then
        echo "      The result set is nonetheless empty, which at tenant scope"
        echo "      points at the search WINDOW: check the start_time this suite"
        echo "      computed (printed with the marker above) against the"
        echo "      platform's clock."
      else
        echo "      ${entries} row(s) came back without it, so the audit write"
        echo "      path, the search path, or the pattern catalogue that makes"
        echo "      the seed a recorded block has drifted."
      fi
      echo "      Either is a finding; neither is a reason to exit 0."
      ;;
    *)
      echo "      The platform sent no X-Axonflow-Read-Scope header, so the read"
      echo "      scope could not be established. Below platform 9.10.0 that is"
      echo "      expected and the empty result is itself the finding; on 9.10.0+"
      echo "      a missing header is the finding."
      ;;
  esac
}

# A FRESH session id per agent turn.
#
# `openclaw agent --local` with no --session-id reuses the main session channel,
# so every suite on a machine appends to one conversation. Measured on this host
# after a day of runs: the shared session's trajectory reached 10.5 MB, the
# compaction safeguard began firing ("using session branch messages after
# compaction preparation omitted real conversation content"), and turns started
# making five model round-trips for a one-command task and returning no reply at
# all. Every model call was HTTP 200 — this is not rate limiting and not the
# model declining.
#
# The symptom is that the agent-driven legs of unrelated suites begin failing as
# a machine accumulates history: status-identity-truth S3, failopen-notice F1-F4
# and audit-search were all observed failing this way within one hour, each
# reporting it as a governance failure. A fresh session makes each turn
# independent of every previous run.
#
# $$ (pid) plus a counter, because two turns in one suite must not collide
# either.
_OPENCLAW_TURN_SEQ=0
openclaw_fresh_session_id() {
  _OPENCLAW_TURN_SEQ=$((_OPENCLAW_TURN_SEQ + 1))
  printf 'axonflow-e2e-%s-%s' "$$" "$_OPENCLAW_TURN_SEQ"
}

# Run a single agent turn against the local OpenClaw runtime.
openclaw_agent_capture() {
  local prompt="$1"
  local output_file="$2"
  # stderr is kept, not discarded: it is where the provider transport and the
  # compaction safeguard report themselves, and without it a degraded turn is
  # indistinguishable from a governance failure.
  timeout 180 openclaw agent \
    --local \
    --agent main \
    --session-id "$(openclaw_fresh_session_id)" \
    --model "$OPENCLAW_E2E_MODEL" \
    --message "$prompt" \
    --json \
    --thinking off \
    >"$output_file" 2>"$output_file.stderr" || true
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
  # -F: every caller passes a literal, and needles are now derived from platform
  # responses (policy names, ids). An unescaped regex metacharacter in a derived
  # value would otherwise change what is asserted — `.` matching any character
  # is the benign end of that; a bare `*` or `[` is a grep error, which grep -q
  # reports as no-match, i.e. a silent FAIL for the wrong reason.
  jq -r '.payloads[]?.text // empty' "$output_file" 2>/dev/null | grep -qF -- "$needle"
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
