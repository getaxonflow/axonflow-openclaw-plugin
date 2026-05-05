#!/usr/bin/env bash
# OpenClaw runtime E2E: V1 paid Pro tier + free email recovery.
#
# Two features wired in one PR per repo, so one runtime test exercises both:
#
#   Feature 1 — X-License-Token forwarding (W4 paid Pro v1, ADR-049)
#     • Configure the plugin with a license token (env or pluginConfig).
#     • Confirm the plugin install log emits the "Pro tier active" canary.
#     • Drive a governed request through the plugin against the live agent.
#     • Confirm the agent's plugin-claim middleware counter incremented —
#       proves the X-License-Token header crossed the wire and reached the
#       middleware (regardless of whether the token validated; we use a
#       deliberately-invalid test token).
#
#   Feature 2 — clawhub-style `recover` flow (W3 free recovery)
#     • Register a fresh community-saas tenant bound to a test email.
#     • Invoke bin/axonflow-openclaw-recover <email> via the plugin's CLI.
#     • Extract the magic-link token from the agent's capture file
#       (AXONFLOW_RECOVERY_TEST_CAPTURE_FILE — must be set on the agent).
#     • Re-invoke the recover CLI with --verify <token>, asserting:
#         - new credentials are issued
#         - try-registration.json is persisted at $AXONFLOW_CONFIG_DIR
#         - the persisted credentials authenticate against the agent
#
# PREREQ ENV (on the agent container):
#   AXONFLOW_RECOVERY_TEST_CAPTURE_FILE  — path the agent writes magic links to
#   STRIPE_WEBHOOK_SIGNING_SECRET        — only needed for the full Stripe
#                                          flow tested by the platform-side
#                                          runtime-e2e test; this plugin test
#                                          uses a deliberately-invalid token
#                                          to verify forwarding only.
#
# PREREQ ENV (on the test-driver shell):
#   AXONFLOW_ENDPOINT       — agent base URL (default http://localhost:8080)
#   AXONFLOW_CLIENT_ID      — community-saas tenant id (default demo-client)
#   AXONFLOW_CLIENT_SECRET  — community-saas tenant secret
#   AXONFLOW_LICENSE_TOKEN  — optional. If set, the test uses this real token
#                             and asserts validations="valid" (full happy
#                             path). If unset, the test mints a sentinel
#                             test-token and asserts validations="invalid_token"
#                             (header-only happy path).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=../_lib/openclaw-runtime.sh
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

runtime_e2e_skip_if_unavailable

CAPTURE_FILE="${AXONFLOW_RECOVERY_TEST_CAPTURE_FILE:-/tmp/axonflow-recovery-captures.txt}"
TEST_EMAIL="${TEST_EMAIL:-w3-w4-runtime-test-$$-$(date +%s)@axonflow-test.invalid}"

# Per-run synthetic source IP for X-Forwarded-For. The agent's
# /api/v1/register and /api/v1/recover share an in-memory per-IP rate
# limiter (5 calls per IP per hour). On a long-running stack the test
# host's real IP often hits that cap quickly, which silently turns the
# recover step into a no-op (the recovery handler returns generic 202
# even when rate-limited, by design, to prevent enumeration). Driving
# each test run from a unique synthetic source-IP keeps the rate-limit
# bucket fresh per run. Safe: extractClientIP() honors XFF unconditionally
# in the local stack, and this header has no effect on routing.
RUNTIME_E2E_XFF="${RUNTIME_E2E_XFF:-10.99.$((RANDOM % 250)).$((RANDOM % 250))}"

# The license token: either the user supplied a real one (full happy path)
# or we mint a deliberately-invalid sentinel (header-forwarding happy path).
# The sentinel must be parseable by the agent middleware (so it reaches the
# DB lookup), but its JTI will not match any plugin_user_licenses row — the
# middleware will increment {result="invalid_token"} or {result="not_found"}.
# Either bucket proves the header was forwarded.
if [ -n "${AXONFLOW_LICENSE_TOKEN:-}" ]; then
    LICENSE_TOKEN_FOR_TEST="$AXONFLOW_LICENSE_TOKEN"
    EXPECT_VALID=1
else
    LICENSE_TOKEN_FOR_TEST="AXON-runtime-e2e-test-token-$(date +%s)-$$"
    EXPECT_VALID=0
fi

CONFIG_DIR_OVERRIDE="${AXONFLOW_CONFIG_DIR:-$(mktemp -d -t axonflow-recover-cfg.XXXXXX)}"
export AXONFLOW_CONFIG_DIR="$CONFIG_DIR_OVERRIDE"

cleanup() {
    echo ""
    echo "=== Cleanup ==="
    # Don't blow away a user-supplied AXONFLOW_CONFIG_DIR — only the temp
    # we created.
    if [[ "$CONFIG_DIR_OVERRIDE" == /tmp/axonflow-recover-cfg.* ]]; then
        rm -rf "$CONFIG_DIR_OVERRIDE" 2>/dev/null || true
    fi
    rm -f "$CAPTURE_FILE" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== runtime-e2e: V1 paid tier (X-License-Token) + W3 recovery — OpenClaw plugin ==="
echo "Agent URL:       $AXONFLOW_ENDPOINT"
echo "Capture file:    $CAPTURE_FILE"
echo "Config dir:      $CONFIG_DIR_OVERRIDE"
echo "Test email:      $TEST_EMAIL"
echo "License token:   ${LICENSE_TOKEN_FOR_TEST:0:24}… (length=${#LICENSE_TOKEN_FOR_TEST})"
echo "Synthetic XFF:   $RUNTIME_E2E_XFF (per-IP rate-limit dodge for /api/v1/register + /api/v1/recover)"
echo "Expect:          $([ "$EXPECT_VALID" = 1 ] && echo "result=valid (real token supplied)" || echo "result=invalid_token (test sentinel)")"
echo ""

# -----------------------------------------------------------------------------
# Feature 1 — X-License-Token forwarding
# -----------------------------------------------------------------------------
echo "--- Feature 1: X-License-Token forwarding ---"

# 1a. Capture pre-test counter values from /metrics (Prometheus exposition).
#     The agent only exposes plugin-claim counters when the enterprise build
#     is in use; for community-only stacks we skip the counter assertion and
#     fall back to the install-log + verbose-stderr capture proof.
echo "Step 1a: snapshot agent /metrics counters (if exposed)"
METRICS_BEFORE=$(curl -sf "$AXONFLOW_ENDPOINT/metrics" 2>/dev/null || true)
if printf '%s' "$METRICS_BEFORE" | grep -q "axonflow_agent_plugin_claim_validations_total"; then
    METRICS_EXPOSED=1
    BEFORE_INVALID=$(printf '%s' "$METRICS_BEFORE" \
        | awk '/^axonflow_agent_plugin_claim_validations_total\{result="invalid_token"\}/ {print $2}' \
        | head -1)
    BEFORE_NOT_FOUND=$(printf '%s' "$METRICS_BEFORE" \
        | awk '/^axonflow_agent_plugin_claim_validations_total\{result="not_found"\}/ {print $2}' \
        | head -1)
    BEFORE_VALID=$(printf '%s' "$METRICS_BEFORE" \
        | awk '/^axonflow_agent_plugin_claim_validations_total\{result="valid"\}/ {print $2}' \
        | head -1)
    BEFORE_INVALID="${BEFORE_INVALID:-0}"
    BEFORE_NOT_FOUND="${BEFORE_NOT_FOUND:-0}"
    BEFORE_VALID="${BEFORE_VALID:-0}"
    echo "  ✓ counter exposed; baseline: invalid=$BEFORE_INVALID not_found=$BEFORE_NOT_FOUND valid=$BEFORE_VALID"
else
    METRICS_EXPOSED=0
    echo "  ⚠ axonflow_agent_plugin_claim_validations_total not exposed at $AXONFLOW_ENDPOINT/metrics"
    echo "    (community-only build, or middleware not registered) — relying on install-log capture"
fi

# 1b. Build + install the local plugin and capture the install output so we
#     can grep for the "Pro tier active" canary.
echo "Step 1b: build + install local plugin with license token configured"
( cd "$PLUGIN_DIR" && npm run --silent build ) >/dev/null 2>&1 || {
    echo "  ✗ FAIL: plugin build failed"
    exit 1
}
INSTALL_LOG=$(mktemp -t axonflow-install.XXXXXX)
(
    cd "$PLUGIN_DIR" \
    && openclaw plugins install --force --dangerously-force-unsafe-install . 2>&1
) > "$INSTALL_LOG"

if ! grep -q "Registered 5 agent-callable tools" "$INSTALL_LOG"; then
    echo "  ✗ FAIL: OpenClaw runtime did not log 'Registered 5 agent-callable tools'"
    tail -20 "$INSTALL_LOG" | sed 's/^/      /'
    exit 1
fi
echo "  ✓ plugin installed"

openclaw config set "plugins.entries.axonflow-governance.config.endpoint" "$AXONFLOW_ENDPOINT" >/dev/null
openclaw config set "plugins.entries.axonflow-governance.config.clientId" "$AXONFLOW_CLIENT_ID" >/dev/null
openclaw config set "plugins.entries.axonflow-governance.config.clientSecret" "$AXONFLOW_CLIENT_SECRET" >/dev/null
openclaw config set "plugins.entries.axonflow-governance.config.userEmail" \
    "${AXONFLOW_TEST_USER_EMAIL:-dev@getaxonflow.com}" >/dev/null
openclaw config set "plugins.entries.axonflow-governance.config.licenseToken" \
    "$LICENSE_TOKEN_FOR_TEST" >/dev/null
echo "  ✓ pluginConfig.licenseToken set"

# 1c. Fire one short agent turn so the plugin actually loads + emits the
#     canary line. The agent doesn't need to do anything substantive — we
#     just want the init log captured. Tool dispatch and HTTP forwarding
#     happen as a side effect.
echo "Step 1c: drive one short agent turn so plugin loads + canary fires"
TURN_LOG=$(mktemp -t axonflow-turn.XXXXXX)
TURN_PROMPT="Say only the literal words DONE. Do not call any tools."
timeout 90 openclaw agent \
    --local \
    --agent main \
    --model "$OPENCLAW_E2E_MODEL" \
    --message "$TURN_PROMPT" \
    --json \
    --thinking off \
    >"$TURN_LOG" 2>&1 || true

# V1 SaaS Plugin Pro tier-line surface parity (codex / cursor / claude /
# openclaw): the canary now has three shapes depending on the token's JWT
# `exp` claim. Match either the parseable-Pro shape ("Pro tier — expires
# YYYY-MM-DD") or the legacy unparseable-Pro shape ("Pro tier active").
# A synthesized non-JWT token (the LICENSE_TOKEN_FOR_TEST fallback) hits
# the legacy branch; a real JWT-shaped token hits the new branch.
if grep -qE "\[AxonFlow\] Pro tier (active|— expires [0-9]{4}-[0-9]{2}-[0-9]{2})" "$TURN_LOG" "$INSTALL_LOG"; then
    echo "  ✓ PASS: Pro tier canary observed in plugin output (active OR expires YYYY-MM-DD shape)"
else
    echo "  ✗ FAIL: Pro tier canary not found in turn log or install log"
    echo "    (either pluginConfig.licenseToken did not stick, or the canary line changed)"
    echo "    install log tail:"
    tail -20 "$INSTALL_LOG" | sed 's/^/      /'
    echo "    turn log tail:"
    tail -20 "$TURN_LOG" | sed 's/^/      /'
    exit 1
fi

# 1d. Drive a governed call so the X-License-Token header lands at the
#     agent. The simplest forced-governance turn is to ask the agent to
#     call axonflow_audit_search — that triggers a request with the same
#     headers as every other governed call (baseHeaders() is the single
#     emit point).
echo "Step 1d: drive a governed call so X-License-Token reaches the agent"
GOVERNED_LOG=$(mktemp -t axonflow-governed.XXXXXX)
GOVERNED_PROMPT="Use the axonflow_audit_search tool with limit=5 to fetch recent audit events. Output exactly the literal text RUNTIME_PROBE_DONE on success."
timeout 120 openclaw agent \
    --local \
    --agent main \
    --model "$OPENCLAW_E2E_MODEL" \
    --message "$GOVERNED_PROMPT" \
    --json \
    --thinking off \
    >"$GOVERNED_LOG" 2>&1 || true

# Even on auth failure (sentinel token is rejected by the middleware), the
# governed request DID reach the agent — that's the proof we want.
sleep 1

# 1e. Compare /metrics counters before/after if exposed.
if [ "$METRICS_EXPOSED" = 1 ]; then
    echo "Step 1e: assert plugin-claim middleware processed the X-License-Token"
    METRICS_AFTER=$(curl -sf "$AXONFLOW_ENDPOINT/metrics" 2>/dev/null || true)
    AFTER_INVALID=$(printf '%s' "$METRICS_AFTER" \
        | awk '/^axonflow_agent_plugin_claim_validations_total\{result="invalid_token"\}/ {print $2}' | head -1)
    AFTER_NOT_FOUND=$(printf '%s' "$METRICS_AFTER" \
        | awk '/^axonflow_agent_plugin_claim_validations_total\{result="not_found"\}/ {print $2}' | head -1)
    AFTER_VALID=$(printf '%s' "$METRICS_AFTER" \
        | awk '/^axonflow_agent_plugin_claim_validations_total\{result="valid"\}/ {print $2}' | head -1)
    AFTER_INVALID="${AFTER_INVALID:-0}"
    AFTER_NOT_FOUND="${AFTER_NOT_FOUND:-0}"
    AFTER_VALID="${AFTER_VALID:-0}"
    echo "  after: invalid=$AFTER_INVALID not_found=$AFTER_NOT_FOUND valid=$AFTER_VALID"

    DELTA_INVALID=$((AFTER_INVALID - BEFORE_INVALID))
    DELTA_NOT_FOUND=$((AFTER_NOT_FOUND - BEFORE_NOT_FOUND))
    DELTA_VALID=$((AFTER_VALID - BEFORE_VALID))

    if [ "$EXPECT_VALID" = 1 ]; then
        if [ "$DELTA_VALID" -ge 1 ]; then
            echo "  ✓ PASS: middleware accepted the real license token (Δvalid=$DELTA_VALID)"
        else
            echo "  ✗ FAIL: real license token did not validate (Δvalid=0; Δinvalid=$DELTA_INVALID Δnot_found=$DELTA_NOT_FOUND)"
            exit 1
        fi
    else
        if [ "$((DELTA_INVALID + DELTA_NOT_FOUND))" -ge 1 ]; then
            echo "  ✓ PASS: middleware processed the X-License-Token header (Δinvalid=$DELTA_INVALID Δnot_found=$DELTA_NOT_FOUND)"
            echo "         — sentinel token rejected as expected; header forwarding confirmed"
        else
            echo "  ✗ FAIL: no plugin-claim counter incremented after governed turn"
            echo "         X-License-Token may not be reaching the agent"
            exit 1
        fi
    fi
else
    echo "Step 1e: skipped /metrics assertion (counter not exposed)"
    echo "  → install-log canary above is the operative proof for community-only builds"
fi

echo ""
echo "--- Feature 1: PASS ---"
echo ""

# -----------------------------------------------------------------------------
# Feature 2 — recover flow
# -----------------------------------------------------------------------------
echo "--- Feature 2: clawhub-style recover flow ---"

# 2a. Capture file must be writable; bail clearly if not.
echo "Step 2a: ensure capture file is writable + empty"
> "$CAPTURE_FILE" 2>/dev/null || {
    echo "  ✗ FAIL: cannot write to $CAPTURE_FILE"
    echo "      Re-run with AXONFLOW_RECOVERY_TEST_CAPTURE_FILE pointing at a shared path"
    echo "      and ensure the agent has the same env var set to the same path."
    exit 1
}
echo "  ✓ capture file ready"

# 2b. Register a fresh tenant with email so /api/v1/recover has something to
#     bind the magic link to. Skip silently if the agent doesn't expose the
#     register endpoint (older platform or non-community-saas mode).
echo "Step 2b: register fresh community-saas tenant with email (XFF=$RUNTIME_E2E_XFF)"
REGISTER_RESP=$(curl -sS -X POST "$AXONFLOW_ENDPOINT/api/v1/register" \
    -H "Content-Type: application/json" \
    -H "X-Forwarded-For: $RUNTIME_E2E_XFF" \
    -d "{\"label\":\"openclaw-runtime-e2e\",\"email\":\"$TEST_EMAIL\"}" \
    -w "\n%{http_code}")
REG_CODE=$(echo "$REGISTER_RESP" | tail -n1)
REG_BODY=$(echo "$REGISTER_RESP" | sed '$d')
if [ "$REG_CODE" != "201" ] && [ "$REG_CODE" != "200" ]; then
    # Distinguish rate-limit (test-driver problem) from "endpoint not present"
    # (community-saas not enabled) so the user knows whether to retry from a
    # different source IP or check the stack mode.
    if [ "$REG_CODE" = "429" ]; then
        echo "  ✗ FAIL: /api/v1/register returned HTTP 429 — per-IP rate limit hit"
        echo "    body: $REG_BODY"
        echo "    The agent enforces 5 registrations per source-IP per hour and the"
        echo "    test driver is dodging it with X-Forwarded-For: $RUNTIME_E2E_XFF."
        echo "    Either an upstream proxy is stripping XFF, or this synthetic IP has"
        echo "    already been used 5+ times in this hour. Re-run with a different"
        echo "    RUNTIME_E2E_XFF=10.x.y.z to pick a fresh bucket."
        exit 1
    fi
    echo "  ⚠ SKIP: /api/v1/register returned HTTP $REG_CODE — agent not in community-saas mode?"
    echo "    body: $REG_BODY"
    echo ""
    echo "  → Skipping Feature 2 (recovery requires community-saas register endpoint)"
    echo "    Feature 1 (X-License-Token) already PASSED above."
    echo ""
    echo "=== runtime-e2e PARTIAL PASS — Feature 1 verified, Feature 2 skipped ==="
    exit 0
fi
ORIGINAL_TENANT_ID=$(echo "$REG_BODY" | jq -r '.tenant_id')
if [ -z "$ORIGINAL_TENANT_ID" ] || [ "$ORIGINAL_TENANT_ID" = "null" ]; then
    echo "  ✗ FAIL: register did not return tenant_id"
    echo "    body: $REG_BODY"
    exit 1
fi
echo "  ✓ original tenant_id=$ORIGINAL_TENANT_ID (bound to $TEST_EMAIL)"

# 2c. Invoke bin/axonflow-openclaw-recover <email> to fire the request step.
#     Use --token-file=<empty> so the CLI exits at the verify step (we
#     handle the verify step separately so we can pass the captured token).
#
#     The CLI cannot inject X-Forwarded-For (it's a user-facing CLI for real
#     users on real networks, not a test-driver), so the CLI's HTTP request
#     uses the test host's real source-IP and will be silently rate-limited
#     after 5 calls per hour (recovery handler returns generic 202 by design).
#     That's fine for proving the CLI's HTTP pipeline works (parses 202, logs
#     it, hands control back) — but it means the CLI alone can't reliably
#     produce a magic-link in the capture file. Step 2c-bis re-fires the same
#     request via curl with our synthetic XFF source-IP to guarantee the
#     magic link is emitted regardless of the test host's rate-limit budget.
echo "Step 2c: invoke recover CLI to verify the CLI's request pipeline against the live agent"
RECOVER_REQ_LOG=$(mktemp -t axonflow-recover-req.XXXXXX)
EMPTY_TOKEN_FILE=$(mktemp -t axonflow-empty.XXXXXX)
> "$EMPTY_TOKEN_FILE"
# CLI reads tokenFile and tries to verify with empty string → exits non-zero
# at the verify step. We tolerate the non-zero exit and grep the log to
# confirm the request step succeeded.
AXONFLOW_ENDPOINT="$AXONFLOW_ENDPOINT" \
    node "$PLUGIN_DIR/bin/axonflow-openclaw-recover.mjs" \
        "$TEST_EMAIL" \
        --token-file "$EMPTY_TOKEN_FILE" \
    >"$RECOVER_REQ_LOG" 2>&1 || true
rm -f "$EMPTY_TOKEN_FILE"

if grep -q "Request accepted (HTTP 202)" "$RECOVER_REQ_LOG"; then
    echo "  ✓ PASS: CLI POST /api/v1/recover returned 202"
else
    echo "  ✗ FAIL: CLI did not log a 202 from /api/v1/recover"
    tail -10 "$RECOVER_REQ_LOG" | sed 's/^/      /'
    exit 1
fi

# 2c-bis. Fire the request again via curl with our synthetic XFF so the
#         agent's per-IP rate-limit bucket is fresh and the magic link is
#         actually emitted to the capture file. The CLI's call above MAY
#         have done this if the test host's real IP is under the hourly
#         cap; if it isn't (long-running stack, repeated runs), the CLI
#         got a generic 202 with no email sent. Re-firing with curl is
#         idempotent on the agent side: the per-email rate limit allows
#         5 recovery requests per hour for a single email address.
echo "Step 2c-bis: re-fire /api/v1/recover via curl with X-Forwarded-For to guarantee email emit"
CURL_RECOVER_RESP=$(curl -sS -X POST "$AXONFLOW_ENDPOINT/api/v1/recover" \
    -H "Content-Type: application/json" \
    -H "X-Forwarded-For: $RUNTIME_E2E_XFF" \
    -d "{\"email\":\"$TEST_EMAIL\"}" \
    -w "\n%{http_code}")
CURL_RECOVER_CODE=$(echo "$CURL_RECOVER_RESP" | tail -n1)
if [ "$CURL_RECOVER_CODE" != "202" ]; then
    echo "  ✗ FAIL: curl re-fire of /api/v1/recover returned HTTP $CURL_RECOVER_CODE (expected 202)"
    echo "    body: $(echo "$CURL_RECOVER_RESP" | sed '$d')"
    exit 1
fi
echo "  ✓ curl re-fire returned 202"

# 2d. Wait for the magic link to land in the capture file, then extract.
echo "Step 2d: extract magic-link token from $CAPTURE_FILE"
for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [ -s "$CAPTURE_FILE" ] && grep -q "to=$TEST_EMAIL" "$CAPTURE_FILE"; then
        break
    fi
    sleep 0.5
done
if ! grep -q "to=$TEST_EMAIL" "$CAPTURE_FILE"; then
    echo "  ✗ FAIL: no captured magic link for $TEST_EMAIL within 5s"
    echo "    capture file head:"
    head -10 "$CAPTURE_FILE" 2>/dev/null | sed 's/^/      /'
    echo "    Probable cause: AXONFLOW_RECOVERY_TEST_CAPTURE_FILE not set on agent or paths differ"
    exit 1
fi
TOKEN_LINE=$(grep "to=$TEST_EMAIL" "$CAPTURE_FILE" | tail -1)
TOKEN=$(echo "$TOKEN_LINE" | sed 's|.*token=||')
if [ -z "$TOKEN" ] || [ ${#TOKEN} -lt 32 ]; then
    echo "  ✗ FAIL: extracted token looks malformed (length=${#TOKEN})"
    echo "    line: $TOKEN_LINE"
    exit 1
fi
echo "  ✓ extracted token (length=${#TOKEN})"

# 2e. Invoke the recover CLI with --verify <token>. Asserts:
#       - exit 0
#       - structured JSON on stdout with tenant_id + saved_at
#       - file at $AXONFLOW_CONFIG_DIR/try-registration.json exists
echo "Step 2e: invoke recover CLI --verify with the captured token"
RECOVER_VERIFY_LOG=$(mktemp -t axonflow-recover-verify.XXXXXX)
RECOVER_VERIFY_OUT=$(mktemp -t axonflow-recover-out.XXXXXX)

if AXONFLOW_ENDPOINT="$AXONFLOW_ENDPOINT" \
    AXONFLOW_CONFIG_DIR="$CONFIG_DIR_OVERRIDE" \
    node "$PLUGIN_DIR/bin/axonflow-openclaw-recover.mjs" \
        --verify "$TOKEN" \
    >"$RECOVER_VERIFY_OUT" 2>"$RECOVER_VERIFY_LOG"; then
    echo "  ✓ CLI exited 0"
else
    echo "  ✗ FAIL: recover --verify exited non-zero"
    echo "    stderr tail:"
    tail -15 "$RECOVER_VERIFY_LOG" | sed 's/^/      /'
    exit 1
fi

NEW_TENANT_ID=$(jq -r '.tenant_id // empty' "$RECOVER_VERIFY_OUT" 2>/dev/null)
NEW_SECRET=$(jq -r '.secret // empty' "$RECOVER_VERIFY_OUT" 2>/dev/null)
SAVED_AT=$(jq -r '.saved_at // empty' "$RECOVER_VERIFY_OUT" 2>/dev/null)
RECOVERED_EMAIL=$(jq -r '.email // empty' "$RECOVER_VERIFY_OUT" 2>/dev/null)

if [ -z "$NEW_TENANT_ID" ]; then
    echo "  ✗ FAIL: CLI did not emit tenant_id on stdout"
    cat "$RECOVER_VERIFY_OUT" | sed 's/^/      /'
    exit 1
fi
if [ "$NEW_TENANT_ID" = "$ORIGINAL_TENANT_ID" ]; then
    echo "  ✗ FAIL: recovery should issue a NEW tenant_id; got the original $ORIGINAL_TENANT_ID"
    exit 1
fi
if [ "$RECOVERED_EMAIL" != "$TEST_EMAIL" ]; then
    echo "  ✗ FAIL: recovered tenant email mismatch"
    echo "    got:      $RECOVERED_EMAIL"
    echo "    expected: $TEST_EMAIL"
    exit 1
fi
if [ -z "$SAVED_AT" ] || [ ! -f "$SAVED_AT" ]; then
    echo "  ✗ FAIL: persisted credential file missing or saved_at empty (saved_at='$SAVED_AT')"
    exit 1
fi
echo "  ✓ new tenant_id=$NEW_TENANT_ID (persisted to $SAVED_AT)"

# 2f. Confirm the persisted file is the same shape the bootstrap reader
#     expects: JSON with tenant_id + secret + expires_at + endpoint, mode 0o600.
echo "Step 2f: verify persisted file shape + permissions"
PERSISTED_TENANT=$(jq -r '.tenant_id // empty' "$SAVED_AT" 2>/dev/null)
PERSISTED_SECRET=$(jq -r '.secret // empty' "$SAVED_AT" 2>/dev/null)
PERSISTED_EXPIRES=$(jq -r '.expires_at // empty' "$SAVED_AT" 2>/dev/null)
PERSISTED_ENDPOINT=$(jq -r '.endpoint // empty' "$SAVED_AT" 2>/dev/null)
if [ "$PERSISTED_TENANT" != "$NEW_TENANT_ID" ] || \
   [ -z "$PERSISTED_SECRET" ] || \
   [ -z "$PERSISTED_EXPIRES" ] || \
   [ -z "$PERSISTED_ENDPOINT" ]; then
    echo "  ✗ FAIL: persisted file is missing required fields"
    cat "$SAVED_AT" | sed 's/^/      /'
    exit 1
fi
if [ "$(uname -s)" != "MINGW"* ] && [ "$(uname -s)" != "CYGWIN"* ]; then
    PERMS=$(stat -f '%OLp' "$SAVED_AT" 2>/dev/null || stat -c '%a' "$SAVED_AT" 2>/dev/null)
    if [ "$PERMS" != "600" ]; then
        echo "  ✗ FAIL: persisted file mode is $PERMS, expected 600"
        exit 1
    fi
fi
echo "  ✓ persisted file shape + 0o600 mode confirmed"

# 2g. Use the recovered credentials to make a real authenticated call.
#     This is the "did recovery actually recover" assertion — if the
#     persisted secret doesn't authenticate, the recovery flow shipped a
#     library that compiled but didn't work end-to-end.
#
#     We deliberately use $AXONFLOW_ENDPOINT (the agent under test), NOT
#     $PERSISTED_ENDPOINT. The persisted endpoint is the platform's static
#     "where users in production should send credentials" string —
#     hardcoded to https://try.getaxonflow.com — which is correct for real
#     users but useless for a runtime-e2e test pointing at a local stack
#     (the local-DB credentials wouldn't authenticate against prod). The
#     persisted endpoint shape + value is asserted in Step 2f above.
#
#     We probe /api/request rather than /api/v1/audit/tool-call because
#     /api/request goes through the agent's apiAuthMiddleware (Basic auth)
#     end-to-end, which is exactly the auth surface recovered creds need
#     to pass. /api/v1/audit/tool-call is reverse-proxied to the
#     orchestrator and additionally requires the operator to set
#     AXONFLOW_INTERNAL_SERVICE_SECRET in non-Community deployments —
#     a stack-config detail unrelated to whether recovery worked.
echo "Step 2g: use recovered credentials to call $AXONFLOW_ENDPOINT/api/request"
NEW_AUTH=$(printf '%s:%s' "$NEW_TENANT_ID" "$NEW_SECRET" | base64 | tr -d '\n')
PROBE_RESP=$(curl -sS -X POST "$AXONFLOW_ENDPOINT/api/request" \
    -H "Content-Type: application/json" \
    -H "Authorization: Basic $NEW_AUTH" \
    -d '{"prompt":"openclaw-runtime-recovery-probe","model":"local-test"}' \
    -w "\n%{http_code}")
PROBE_CODE=$(echo "$PROBE_RESP" | tail -n1)
if [ "$PROBE_CODE" != "200" ] && [ "$PROBE_CODE" != "201" ]; then
    echo "  ✗ FAIL: recovered credentials did not authenticate (HTTP $PROBE_CODE)"
    echo "    body: $(echo "$PROBE_RESP" | sed '$d')"
    exit 1
fi
PROBE_BODY=$(echo "$PROBE_RESP" | sed '$d')
PROBE_TID=$(echo "$PROBE_BODY" | jq -r '.policy_info.tenant_id // empty' 2>/dev/null)
if [ -n "$PROBE_TID" ] && [ "$PROBE_TID" != "$NEW_TENANT_ID" ]; then
    echo "  ✗ FAIL: probe response identified a different tenant ($PROBE_TID) than recovered tenant ($NEW_TENANT_ID)"
    exit 1
fi
echo "  ✓ PASS: recovered credentials authenticate end-to-end (HTTP $PROBE_CODE${PROBE_TID:+, tenant=$PROBE_TID})"

echo ""
echo "--- Feature 2: PASS ---"
echo ""
echo "=== runtime-e2e: ALL ASSERTIONS PASSED — V1 paid tier + recovery work end-to-end ==="
exit 0
