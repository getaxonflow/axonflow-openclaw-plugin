# Starter Policies for OpenClaw

These SQL statements add AxonFlow system policies optimized for OpenClaw deployments. Run them against your AxonFlow database after initial setup.

## Web Fetch / HTTP Tools

Block credential exfiltration and SSRF patterns in web_fetch tool arguments:

```sql
INSERT INTO static_policies (name, category, pattern, severity, action_request, action_response, description)
VALUES
  ('openclaw_block_internal_hosts', 'security_dangerous', '(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)', 'high', 'block', 'allow', 'Block requests to internal/private network hosts'),
  ('openclaw_block_credential_urls', 'security_dangerous', '(metadata\.google|169\.254\.169\.254|metadata\.aws)', 'critical', 'block', 'allow', 'Block requests to cloud metadata endpoints');
```

## Message / Communication Tools

Prevent PII from being sent in outbound messages:

```sql
-- PII detection is handled by the 83 built-in system policies (sys_pii_ssn, sys_pii_credit_card, etc.)
-- For OpenClaw message tools, ensure action_request = 'block' (not 'warn') for critical PII:
UPDATE static_policies SET action_request = 'block'
WHERE name IN ('sys_pii_ssn', 'sys_pii_credit_card', 'sys_pii_aadhaar')
  AND category LIKE 'pii_%';
```

## Tool Result Scanning

The built-in PII system policies automatically scan tool results when `mcp_check_output` is called. No additional setup needed for:
- SSN detection and redaction
- Credit card detection and redaction
- Email/phone detection
- Secrets detection (API keys, connection strings)

## Rate Limiting (Dynamic Policies)

To add rate limits on high-risk tools, create dynamic policies via the AxonFlow API:

```bash
curl -X POST http://localhost:8080/api/v1/dynamic-policies \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n 'admin:secret' | base64)" \
  -d '{
    "name": "openclaw_web_fetch_rate_limit",
    "policy_type": "rate-limit",
    "config": {
      "max_requests": 100,
      "window_seconds": 60,
      "scope": "tenant"
    },
    "connector_filter": "openclaw.web_fetch"
  }'
```

## Recommended PII_ACTION Setting

For OpenClaw deployments, set `PII_ACTION=redact` (default) for output scanning. This redacts PII in tool results before they reach the LLM, without blocking the entire response.

For strict environments, set `PII_ACTION=block` to reject any tool result containing PII.
