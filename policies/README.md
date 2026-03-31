# Starter Policies for OpenClaw

Default policy configurations for protecting OpenClaw deployments with AxonFlow. Based on real-world security incidents and research from Microsoft, Kaspersky, Cisco, Giskard, and the OpenClaw CVE history.

## Why These Policies Matter

As of March 2026, OpenClaw has 135,000+ instances exposed on the public internet, 4 CVEs disclosed (including CVE-2026-25253 at CVSS 8.8), and the ClawHavoc supply chain attack poisoned 1,184 skills in ClawHub. Microsoft recommends: "It is not appropriate to run on a standard personal or enterprise workstation."

AxonFlow adds centralized governance at every data boundary: tool inputs, tool outputs, outbound messages, and LLM calls.

## Top 10 Risks (Ranked by Severity)

| Rank | Risk | Covered By |
|------|------|-----------|
| 1 | Arbitrary command execution (reverse shells, crypto miners, rm -rf) | `before_tool_call` — exec command blocking |
| 2 | Data exfiltration via web_fetch/browser to external URLs | `before_tool_call` — PII/credential detection in URLs |
| 3 | PII/credential leakage in tool outputs | `tool_result_persist` — PII redaction |
| 4 | Indirect prompt injection via ingested content | `tool_result_persist` — injection pattern detection |
| 5 | Outbound message exfiltration (secrets to unauthorized channels) | `message_sending` — PII/secret scanning |
| 6 | Malicious skill supply chain (ClawHavoc-style) | `after_tool_call` — audit trail for forensics |
| 7 | Memory/context poisoning (SOUL.md/MEMORY.md modification) | `before_tool_call` — block writes to agent config files |
| 8 | Credential exposure in plaintext config/logs | `tool_result_persist` — secret pattern detection |
| 9 | Cross-tenant context leakage | Tenant-scoped policy enforcement |
| 10 | Privilege escalation via workspace boundary bypass (CVE-2026-33573) | `before_tool_call` — path traversal detection |

## What's Protected Automatically

These protections require NO additional setup. AxonFlow's 76+ built-in system policies apply automatically when the plugin calls `mcp_check_input` and `mcp_check_output`:

| Protection | System Policies |
|-----------|----------------|
| SSN detection/redaction | sys_pii_ssn |
| Credit card detection | sys_pii_credit_card |
| Email detection | sys_pii_email |
| Phone number detection | sys_pii_phone |
| Aadhaar number detection | sys_pii_aadhaar |
| PAN card detection | sys_pii_pan |
| SQL injection blocking | sys_sqli_* (37+ patterns) |
| Dangerous commands | sys_dangerous_* |
| API key detection | sys_secrets_api_key |
| Connection string detection | sys_secrets_connection_string |
| Code secrets detection | sys_code_secrets_* |

## OpenClaw-Specific Hardening

For additional protection against OpenClaw-specific attack vectors, add these policies.

### Risk 1: Dangerous Command Execution

Block reverse shells, destructive commands, and credential access in exec tool arguments. These patterns address the most common attack vectors observed in OpenClaw security incidents.

```sql
-- Block reverse shells and remote code execution
INSERT INTO static_policies (name, category, pattern, severity, action_request, action_response, description)
VALUES
  ('openclaw_block_reverse_shells', 'security_dangerous', '(nc\s+-e|bash\s+-i|/dev/tcp/|python\s+-c.*socket|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh|base64\s+.*-d\s+.*\|\s*sh)', 'critical', 'block', 'allow', 'Block reverse shell and remote code execution patterns in exec tool'),
  ('openclaw_block_destructive_fs', 'security_dangerous', '(rm\s+-rf\s+/|rm\s+-rf\s+~|dd\s+if=|mkfs\b|>\s*/dev/sd|chmod\s+-R\s+777\s+/)', 'critical', 'block', 'allow', 'Block destructive filesystem operations'),
  ('openclaw_block_credential_access', 'security_dangerous', '(cat\s+.*\.ssh/|cat\s+.*\.aws/|cat\s+.*\.env\b|cat\s+.*\.netrc|cat\s+.*\.gnupg/|printenv\s+.*KEY|printenv\s+.*SECRET|printenv\s+.*TOKEN)', 'high', 'block', 'allow', 'Block credential file and environment variable access');
```

### Risk 2: Data Exfiltration via HTTP

Block requests to cloud metadata endpoints and internal networks (SSRF):

```sql
INSERT INTO static_policies (name, category, pattern, severity, action_request, action_response, description)
VALUES
  ('openclaw_block_metadata_endpoints', 'security_dangerous', '(169\.254\.169\.254|metadata\.google|metadata\.aws)', 'critical', 'block', 'allow', 'Block cloud metadata endpoint access (SSRF protection)'),
  ('openclaw_block_internal_networks', 'security_dangerous', '(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.)', 'high', 'block', 'allow', 'Block requests to internal/private network addresses');
```

### Risk 7: Agent Config File Protection

Block writes to OpenClaw's persistent context files to prevent memory poisoning attacks:

```sql
INSERT INTO static_policies (name, category, pattern, severity, action_request, action_response, description)
VALUES
  ('openclaw_protect_agent_config', 'security_dangerous', '(SOUL\.md|MEMORY\.md|IDENTITY\.md|AGENTS\.md|openclaw\.json|auth-profiles\.json)', 'high', 'block', 'allow', 'Block modification of OpenClaw agent identity and memory files');
```

### Risk 10: Workspace Boundary Protection

Block path traversal attempts that could escape workspace isolation (CVE-2026-33573 pattern):

```sql
INSERT INTO static_policies (name, category, pattern, severity, action_request, action_response, description)
VALUES
  ('openclaw_block_path_traversal', 'security_dangerous', '(\.\./|/etc/passwd|/etc/shadow|/proc/self)', 'high', 'block', 'allow', 'Block path traversal and sensitive system file access');
```

## Recommended Plugin Configuration

```yaml
plugins:
  @axonflow/openclaw-plugin:
    endpoint: http://your-axonflow:8080
    clientId: your-client-id
    clientSecret: your-secret
    highRiskTools:
      - exec
      - process
      - browser
      - web_fetch
      - message
    onError: block  # fail-closed for security-sensitive deployments
```

Setting `onError: block` means if AxonFlow is unreachable, tool calls are blocked rather than allowed. This is the safer default for production. Use `onError: allow` for development where AxonFlow availability is less critical.

## References

- [Running OpenClaw safely (Microsoft Security Blog, Feb 2026)](https://www.microsoft.com/en-us/security/blog/2026/02/19/running-openclaw-safely-identity-isolation-runtime-risk/)
- [OpenClaw Security Challenges (DigitalOcean)](https://www.digitalocean.com/resources/articles/openclaw-security-challenges)
- [OpenClaw security: architecture and hardening guide (Nebius)](https://nebius.com/blog/posts/openclaw-security)
- [ClawHavoc Supply Chain Attack (Antiy Labs)](https://www.antiy.net/p/clawhavoc-analysis-of-large-scale-poisoning-campaign-targeting-the-openclaw-skill-market-for-ai-agents/)
- [Personal AI Agents Are a Security Nightmare (Cisco Blogs)](https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare)
- [OpenClaw Prompt Injection Risks (Giskard)](https://www.giskard.ai/knowledge/openclaw-security-vulnerabilities-include-data-leakage-and-prompt-injection-risks)
