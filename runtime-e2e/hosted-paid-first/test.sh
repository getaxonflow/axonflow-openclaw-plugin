#!/usr/bin/env bash
# Live Hosted Starter runtime proof for #4487.
#
# This test drives the compiled AxonFlow client and the installed plugin in a
# real OpenClaw agent process against a deployed AxonFlow endpoint. It creates
# an authenticated Stripe Checkout session for an unpaid test tenant, but it
# never completes payment and never prints the session URL or credentials.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONFIRM_VALUE="hosted-paid-first"
if [ "${AXONFLOW_HOSTED_E2E_CONFIRM:-}" != "$CONFIRM_VALUE" ]; then
  echo "SKIP: live Hosted Starter proof is opt-in."
  echo "      Set AXONFLOW_HOSTED_E2E_CONFIRM=$CONFIRM_VALUE with the required test credentials."
  exit 0
fi

required_env=(
  AXONFLOW_ENDPOINT
  AXONFLOW_UNPAID_CLIENT_ID
  AXONFLOW_UNPAID_CLIENT_SECRET
  AXONFLOW_PAID_CLIENT_ID
  AXONFLOW_PAID_CLIENT_SECRET
)
for name in "${required_env[@]}"; do
  if [ -z "${!name:-}" ]; then
    echo "FAIL: $name is required for the live Hosted Starter proof"
    exit 1
  fi
done

# The shared helper supplies local-development defaults, so source it only
# after proving that this certification run received every live credential.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../_lib/openclaw-runtime.sh"

# Ambient entitlement and identity values can turn an unpaid tenant into a
# false paid-path result. This proof exercises only the two credential pairs
# named above.
unset AXONFLOW_LICENSE_TOKEN AXONFLOW_USER_TOKEN AXONFLOW_PEP_AUDIENCE

case "$AXONFLOW_ENDPOINT" in
  https://*) ;;
  *)
    echo "FAIL: AXONFLOW_ENDPOINT must use HTTPS for the deployed runtime proof"
    exit 1
    ;;
esac

TARGET="${AXONFLOW_HOSTED_E2E_TARGET:-production}"
case "$TARGET" in
  production)
    if [ "$AXONFLOW_ENDPOINT" != "https://try.getaxonflow.com" ]; then
      echo "FAIL: production proof must target https://try.getaxonflow.com"
      exit 1
    fi
    ;;
  staging) ;;
  *)
    echo "FAIL: AXONFLOW_HOSTED_E2E_TARGET must be production or staging"
    exit 1
    ;;
esac

EXPECTED_CHECKOUT_HOST="${AXONFLOW_EXPECTED_CHECKOUT_HOST:-checkout.stripe.com}"
EXPECTED_PORTAL_HOST="${AXONFLOW_EXPECTED_PORTAL_HOST:-billing.stripe.com}"
EVIDENCE_ROOT="${AXONFLOW_E2E_EVIDENCE_DIR:-$SCRIPT_DIR/EVIDENCE/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$EVIDENCE_ROOT"

for tool in curl jq node npm openclaw timeout; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: $tool is required for the live Hosted Starter proof"
    exit 1
  fi
done

if ! curl -sSf -o /dev/null --max-time 10 "$AXONFLOW_ENDPOINT/health"; then
  echo "FAIL: deployed AxonFlow health endpoint is not reachable at $AXONFLOW_ENDPOINT"
  exit 1
fi

echo "--- Building the exact plugin under test ---"
(cd "$PLUGIN_DIR" && npm run --silent build)

DRIVER_FILE="$(mktemp -t axonflow-hosted-paid-first-driver.XXXXXX.mjs)"
DRIVER_RESULT="$(mktemp -t axonflow-hosted-paid-first-result.XXXXXX.json)"
OPENCLAW_OUT="$(mktemp -t axonflow-hosted-paid-first-openclaw.XXXXXX.json)"
OPENCLAW_ERR="$(mktemp -t axonflow-hosted-paid-first-openclaw.XXXXXX.stderr)"
SECRET_FILE="$(mktemp -t axonflow-hosted-paid-first-secret.XXXXXX)"
RUN_CACHE_DIR="$(mktemp -d -t axonflow-hosted-paid-first-cache.XXXXXX)"
OPENCLAW_CONFIG_FILE="${OPENCLAW_CONFIG_FILE:-$HOME/.openclaw/openclaw.json}"
CONFIG_BACKUP="$(mktemp -t axonflow-hosted-paid-first-config.XXXXXX)"
CONFIG_EXISTED=0
chmod 700 "$RUN_CACHE_DIR"
export AXONFLOW_CACHE_DIR="$RUN_CACHE_DIR"

if [ -f "$OPENCLAW_CONFIG_FILE" ]; then
  cp "$OPENCLAW_CONFIG_FILE" "$CONFIG_BACKUP"
  CONFIG_EXISTED=1
fi

cleanup() {
  if [ "$CONFIG_EXISTED" = "1" ]; then
    cp "$CONFIG_BACKUP" "$OPENCLAW_CONFIG_FILE"
  else
    rm -f "$OPENCLAW_CONFIG_FILE"
  fi
  rm -f "$CONFIG_BACKUP" "$DRIVER_FILE" "$DRIVER_RESULT" \
    "$OPENCLAW_OUT" "$OPENCLAW_ERR" "$SECRET_FILE"
  rm -rf "$RUN_CACHE_DIR"
}
trap cleanup EXIT INT TERM HUP

cat >"$DRIVER_FILE" <<'NODE'
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const endpoint = process.env.AXONFLOW_ENDPOINT.replace(/\/+$/, "");
const expectedCheckoutHost = process.env.AXONFLOW_EXPECTED_CHECKOUT_HOST;
const expectedPortalHost = process.env.AXONFLOW_EXPECTED_PORTAL_HOST;
const clientModule = await import(pathToFileURL(`${process.env.PLUGIN_DIR}/dist/axonflow-client.js`));
const { AxonFlowClient, AxonFlowPaymentRequiredError } = clientModule;

function client(clientId, clientSecret) {
  return new AxonFlowClient({
    endpoint,
    clientId,
    clientSecret,
    mode: "self-hosted",
    onError: "block",
    requestTimeoutMs: 15000,
  });
}

async function billingStatus(clientId, clientSecret) {
  const authorization = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(`${endpoint}/api/v1/billing/status`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authorization}`,
      "Content-Type": "application/json",
      "X-Axonflow-Client": "openclaw/runtime-e2e",
    },
    body: "{}",
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`billing status failed with HTTP ${response.status}`);
  }
  return body;
}

function assertStarterPlan(body, label) {
  const plan = body.plan ?? {};
  const requiredFeatures = [
    "governance",
    "fincrime",
    "payment_exception",
    "support_refund",
    "secure_customer_portal",
  ];
  if (body.price_usd_monthly !== "9.99") {
    throw new Error(`${label} did not report the $9.99 monthly price`);
  }
  if (plan.included_seats !== 2 || plan.included_case_evaluations !== 100 ||
      plan.included_standard_integrations !== 1 || plan.retention_days !== 30) {
    throw new Error(`${label} did not report the approved Hosted Starter limits`);
  }
  if (!requiredFeatures.every((feature) => plan.features?.includes(feature))) {
    throw new Error(`${label} did not report every required Hosted Starter feature`);
  }
}

async function createPortal(clientId, clientSecret) {
  const authorization = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(`${endpoint}/api/v1/billing/portal`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authorization}`,
      "Content-Type": "application/json",
      "X-Axonflow-Client": "openclaw/runtime-e2e",
    },
    body: "{}",
  });
  const body = await response.json();
  if (response.status !== 201 || typeof body.portal_url !== "string") {
    throw new Error(`billing portal failed with HTTP ${response.status}`);
  }
  return new URL(body.portal_url);
}

const unpaidStatus = await billingStatus(
  process.env.AXONFLOW_UNPAID_CLIENT_ID,
  process.env.AXONFLOW_UNPAID_CLIENT_SECRET,
);
if (unpaidStatus.status !== "payment_required") {
  throw new Error(`unpaid tenant status is ${String(unpaidStatus.status)}, expected payment_required`);
}
if (unpaidStatus.launch_accepted !== true) {
  throw new Error("deployed endpoint has not accepted the hosted launch gates");
}
assertStarterPlan(unpaidStatus, "unpaid billing status");

const warnings = [];
const unpaidClient = client(
  process.env.AXONFLOW_UNPAID_CLIENT_ID,
  process.env.AXONFLOW_UNPAID_CLIENT_SECRET,
);
unpaidClient.setUpgradePromptLogger({
  info: (message) => warnings.push(String(message)),
  warn: (message) => warnings.push(String(message)),
  error: (message) => warnings.push(String(message)),
});

let paymentError;
try {
  await unpaidClient.mcpCheckInput(
    "openclaw.runtime_e2e",
    JSON.stringify({ action: "hosted-paid-first-proof" }),
    "execute",
    `openclaw-unpaid-${Date.now()}`,
  );
  throw new Error("unpaid governed request was allowed");
} catch (error) {
  if (!(error instanceof AxonFlowPaymentRequiredError)) throw error;
  paymentError = error;
}

if (paymentError.status !== 402 || paymentError.responseBody?.error !== "hosted_payment_required") {
  throw new Error("unpaid request did not return the structured hosted payment-required error");
}
const checkout = new URL(paymentError.checkoutUrl);
if (checkout.protocol !== "https:" || checkout.host !== expectedCheckoutHost) {
  throw new Error(`checkout host is ${checkout.host}, expected ${expectedCheckoutHost}`);
}
if (warnings.length !== 1 || !warnings[0].includes(paymentError.checkoutUrl)) {
  throw new Error("compiled client did not surface the authenticated Checkout URL exactly once");
}
if (warnings[0].includes(process.env.AXONFLOW_UNPAID_CLIENT_ID) ||
    /copy.*tenant|tenant.*id|license token/i.test(warnings[0])) {
  throw new Error("Checkout prompt exposed an identity or asked for manual credential handling");
}

const paidStatus = await billingStatus(
  process.env.AXONFLOW_PAID_CLIENT_ID,
  process.env.AXONFLOW_PAID_CLIENT_SECRET,
);
if (paidStatus.status !== "active" || paidStatus.billing_portal_available !== true) {
  throw new Error(`paid tenant status is ${String(paidStatus.status)}, expected active subscription with portal`);
}
assertStarterPlan(paidStatus, "paid billing status");

const portal = await createPortal(
  process.env.AXONFLOW_PAID_CLIENT_ID,
  process.env.AXONFLOW_PAID_CLIENT_SECRET,
);
if (portal.protocol !== "https:" || portal.host !== expectedPortalHost) {
  throw new Error(`portal host is ${portal.host}, expected ${expectedPortalHost}`);
}

const paidResult = await client(
  process.env.AXONFLOW_PAID_CLIENT_ID,
  process.env.AXONFLOW_PAID_CLIENT_SECRET,
).mcpCheckInput(
  "openclaw.runtime_e2e",
  JSON.stringify({ action: "hosted-paid-first-proof" }),
  "execute",
  `openclaw-paid-${Date.now()}`,
);
if (typeof paidResult.allowed !== "boolean") {
  throw new Error("paid governed request did not reach the policy decision surface");
}

console.log(JSON.stringify({
  endpoint,
  target: process.env.AXONFLOW_HOSTED_E2E_TARGET,
  unpaid_status: unpaidStatus.status,
  unpaid_http_status: paymentError.status,
  unpaid_error: paymentError.responseBody.error,
  checkout_host: checkout.host,
  checkout_url_sha256: createHash("sha256").update(paymentError.checkoutUrl).digest("hex"),
  checkout_prompt_count: warnings.length,
  paid_status: paidStatus.status,
  portal_host: portal.host,
  portal_url_sha256: createHash("sha256").update(portal.href).digest("hex"),
  paid_policy_decision: paidResult.allowed ? "allowed" : "blocked_by_policy",
}));
NODE

echo "--- Proving unpaid and paid paths through the compiled client ---"
PLUGIN_DIR="$PLUGIN_DIR" \
AXONFLOW_EXPECTED_CHECKOUT_HOST="$EXPECTED_CHECKOUT_HOST" \
AXONFLOW_EXPECTED_PORTAL_HOST="$EXPECTED_PORTAL_HOST" \
AXONFLOW_HOSTED_E2E_TARGET="$TARGET" \
node "$DRIVER_FILE" >"$DRIVER_RESULT"
jq . "$DRIVER_RESULT"

echo "--- Installing the plugin into the real OpenClaw host ---"
export AXONFLOW_CLIENT_ID="$AXONFLOW_UNPAID_CLIENT_ID"
export AXONFLOW_CLIENT_SECRET="$AXONFLOW_UNPAID_CLIENT_SECRET"
openclaw_install_local_plugin

# Remove local exclusions that could make a host-level block assertion pass
# without reaching AxonFlow. The original config is restored by cleanup.
OPENCLAW_CONFIG_FILE="$OPENCLAW_CONFIG_FILE" node --input-type=module -e '
import fs from "node:fs";
const path = process.env.OPENCLAW_CONFIG_FILE;
const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
const plugin = cfg.plugins.entries["axonflow-governance"].config;
plugin.onError = "block";
plugin.governedTools = [];
plugin.excludedTools = [];
delete plugin.licenseToken;
delete plugin.userToken;
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
'

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  if ! timeout 15 openclaw agent --local --model "$OPENCLAW_E2E_MODEL" \
    --message "reply with ok" --json --session-id "__hosted-auth-probe-$$" 2>&1 | grep -q '"payloads"'; then
    echo "FAIL: real OpenClaw host proof needs a configured model credential"
    exit 1
  fi
fi

NONCE="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s' "$NONCE" >"$SECRET_FILE"
PROMPT="Use a shell tool to run exactly: cat $SECRET_FILE
Do not guess or describe the command. Return only its stdout."

AXONFLOW_TELEMETRY=off openclaw_agent_capture "$PROMPT" "$OPENCLAW_OUT"
if [ -f "$OPENCLAW_OUT.stderr" ]; then
  cp "$OPENCLAW_OUT.stderr" "$OPENCLAW_ERR"
fi

TOOL_CALLS="$(jq -r '(.meta.toolSummary.calls // .meta.agentMeta.toolSummary.calls // 0)' "$OPENCLAW_OUT" 2>/dev/null || echo 0)"
case "$TOOL_CALLS" in ''|*[!0-9]*) TOOL_CALLS=0 ;; esac
if [ "$TOOL_CALLS" -lt 1 ]; then
  echo "FAIL: OpenClaw did not dispatch a tool, so the host block assertion is vacuous"
  exit 1
fi
if jq -r '(.meta.toolSummary.tools // .meta.agentMeta.toolSummary.tools // [])[]?' "$OPENCLAW_OUT" \
  | grep -qEi '(^|_)(exec|bash|shell)($|_)'; then
  :
else
  echo "FAIL: OpenClaw dispatched tools, but no shell tool was observed"
  exit 1
fi
if grep -qF "$NONCE" "$OPENCLAW_OUT" "$OPENCLAW_ERR"; then
  echo "FAIL: the unpaid host executed the governed shell command"
  exit 1
fi
if ! grep -qF "Complete checkout: https://$EXPECTED_CHECKOUT_HOST" "$OPENCLAW_OUT" "$OPENCLAW_ERR"; then
  echo "FAIL: the real OpenClaw host did not surface the one-action Checkout URL"
  exit 1
fi

jq -n \
  --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg endpoint "$AXONFLOW_ENDPOINT" \
  --arg target "$TARGET" \
  --argjson tool_calls "$TOOL_CALLS" \
  --slurpfile client "$DRIVER_RESULT" \
  '{result:"PASS",completed_at:$completed_at,endpoint:$endpoint,target:$target,openclaw_tool_calls:$tool_calls,client:$client[0]}' \
  >"$EVIDENCE_ROOT/summary.json"

echo "PASS: unpaid call created and surfaced authenticated Checkout, OpenClaw blocked execution, paid call reached policy"
echo "Sanitized evidence: $EVIDENCE_ROOT/summary.json"
