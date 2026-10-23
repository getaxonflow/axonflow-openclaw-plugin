#!/usr/bin/env bash
# Load the dedicated Hosted Starter E2E identities from AWS Secrets Manager
# without placing credential values in shell history or command arguments.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGION="${AWS_REGION:-us-east-1}"
TARGET="${AXONFLOW_HOSTED_E2E_TARGET:-staging}"

case "$TARGET" in
  staging)
    DEFAULT_SECRET_ID="axonflow/community-saas-staging/hosted-paid-first-e2e"
    ;;
  production)
    DEFAULT_SECRET_ID="axonflow/community-saas/hosted-paid-first-e2e"
    ;;
  *)
    echo "FAIL: AXONFLOW_HOSTED_E2E_TARGET must be staging or production" >&2
    exit 1
    ;;
esac

SECRET_ID="${AXONFLOW_HOSTED_E2E_SECRET_ID:-$DEFAULT_SECRET_ID}"
SECRET_FILE="$(mktemp -t axonflow-hosted-e2e-secret.XXXXXX)"
chmod 600 "$SECRET_FILE"

cleanup() {
  unset AXONFLOW_UNPAID_CLIENT_ID AXONFLOW_UNPAID_CLIENT_SECRET
  unset AXONFLOW_PAID_CLIENT_ID AXONFLOW_PAID_CLIENT_SECRET
  rm -f "$SECRET_FILE"
}
trap cleanup EXIT INT TERM HUP

for tool in aws jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: $tool is required" >&2
    exit 1
  fi
done

aws secretsmanager get-secret-value \
  --region "$REGION" \
  --secret-id "$SECRET_ID" \
  --query SecretString \
  --output text >"$SECRET_FILE"

required_keys=(
  unpaid_client_id
  unpaid_client_secret
  paid_client_id
  paid_client_secret
  endpoint
)
for key in "${required_keys[@]}"; do
  if ! jq -e --arg key "$key" \
      'type == "object" and (.[$key] | type == "string" and length > 0)' \
      "$SECRET_FILE" >/dev/null; then
    echo "FAIL: Secrets Manager bundle $SECRET_ID is missing non-empty key: $key" >&2
    exit 1
  fi
done

export AXONFLOW_UNPAID_CLIENT_ID
export AXONFLOW_UNPAID_CLIENT_SECRET
export AXONFLOW_PAID_CLIENT_ID
export AXONFLOW_PAID_CLIENT_SECRET
export AXONFLOW_ENDPOINT
export AXONFLOW_HOSTED_E2E_TARGET="$TARGET"
export AXONFLOW_HOSTED_E2E_CONFIRM=hosted-paid-first

AXONFLOW_UNPAID_CLIENT_ID=$(jq -r .unpaid_client_id "$SECRET_FILE")
AXONFLOW_UNPAID_CLIENT_SECRET=$(jq -r .unpaid_client_secret "$SECRET_FILE")
AXONFLOW_PAID_CLIENT_ID=$(jq -r .paid_client_id "$SECRET_FILE")
AXONFLOW_PAID_CLIENT_SECRET=$(jq -r .paid_client_secret "$SECRET_FILE")
AXONFLOW_ENDPOINT=$(jq -r .endpoint "$SECRET_FILE")

bash "$SCRIPT_DIR/test.sh"
