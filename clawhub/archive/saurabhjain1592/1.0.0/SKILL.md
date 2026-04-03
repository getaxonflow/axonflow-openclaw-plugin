---
name: axonflow-governance-policies
description: Set up governance policies for OpenClaw — block dangerous commands, detect PII, prevent data exfiltration, protect agent config files. Use when hardening an OpenClaw deployment with AxonFlow.
homepage: https://github.com/getaxonflow/axonflow-openclaw-plugin/tree/main/policies
tags: security, governance, pii, compliance, openclaw
---

# AxonFlow Governance Policies for OpenClaw

Use when setting up or hardening an OpenClaw deployment with AxonFlow governance. This skill covers policy configuration, risk mitigation, and recommended settings.

## Prerequisites

AxonFlow must be running and the plugin installed:

```bash
git clone https://github.com/getaxonflow/axonflow.git
cd axonflow && docker compose up -d
openclaw plugins install @axonflow/openclaw
```

Configure in your OpenClaw config:

```yaml
plugins:
  @axonflow/openclaw:
    endpoint: http://localhost:8080
    clientId: your-client-id
    clientSecret: your-secret
    highRiskTools:
      - exec
      - process
      - browser
      - web_fetch
      - message
    onError: block
```

`onError: block` means tool calls are blocked if AxonFlow is unreachable. Use `allow` only in development.

## What's Protected Automatically

AxonFlow's built-in system policies apply with no additional setup:

- PII: SSN, credit card, email, phone, Aadhaar, PAN
- SQL injection: built-in detection patterns
- Dangerous commands: destructive operations, privilege escalation
- Secrets: API keys, connection strings, code secrets

## OpenClaw-Specific Hardening Policies

Add these for protection against OpenClaw-specific attack vectors.

### Block Reverse Shells and Destructive Commands

```sql
INSERT INTO static_policies (name, category, pattern, severity, action_request, action_response, description)
VALUES
  ('openclaw_block_reverse_shells', 'security_dangerous', '(nc\s+-e|bash\s+-i|/dev/tcp/|python\s+-c.*socket|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh|base64\s+.*-d\s+.*\|\s*sh)', 'critical', 'block', 'allow', 'Block reverse shell and remote code execution patterns'),
  ('openclaw_block_destructive_fs', 'security_dangerous', '(rm\s+-rf\s+/|rm\s+-rf\s+~|dd\s+if=|mkfs\b|>\s*/dev/sd|chmod\s+-R\s+777\s+/)', 'critical', 'block', 'allow', 'Block destructive filesystem operations'),
  ('openclaw_block_credential_access', 'security_dangerous', '(cat\s+.*\.ssh/|cat\s+.*\.aws/|cat\s+.*\.env\b|cat\s+.*\.netrc|cat\s+.*\.gnupg/|printenv\s+.*KEY|printenv\s+.*SECRET|printenv\s+.*TOKEN)', 'high', 'block', 'allow', 'Block credential file and environment variable access');
```

### Block Data Exfiltration (SSRF)

```sql
INSERT INTO static_policies (name, category, pattern, severity, action_request, action_response, description)
VALUES
  ('openclaw_block_metadata_endpoints', 'security_dangerous', '(169\.254\.169\.254|metadata\.google|metadata\.aws)', 'critical', 'block', 'allow', 'Block cloud metadata endpoint access'),
  ('openclaw_block_internal_networks', 'security_dangerous', '(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.)', 'high', 'block', 'allow', 'Block requests to internal/private network addresses');
```

### Protect Agent Config Files

Block writes to OpenClaw's persistent context files to prevent memory poisoning:

```sql
INSERT INTO static_policies (name, category, pattern, severity, action_request, action_response, description)
VALUES
  ('openclaw_protect_agent_config', 'security_dangerous', '(SOUL\.md|MEMORY\.md|IDENTITY\.md|AGENTS\.md|openclaw\.json|auth-profiles\.json)', 'high', 'block', 'allow', 'Block modification of OpenClaw agent identity and memory files');
```

### Block Path Traversal

Prevent workspace escape (CVE-2026-33573 pattern):

```sql
INSERT INTO static_policies (name, category, pattern, severity, action_request, action_response, description)
VALUES
  ('openclaw_block_path_traversal', 'security_dangerous', '(\.\./|/etc/passwd|/etc/shadow|/proc/self)', 'high', 'block', 'allow', 'Block path traversal and sensitive system file access');
```

## Top 10 Risks

| Rank | Risk | Hook |
|------|------|------|
| 1 | Arbitrary command execution | before_tool_call |
| 2 | Data exfiltration via HTTP | before_tool_call |
| 3 | PII leakage in messages | message_sending |
| 4 | Indirect prompt injection | before_tool_call |
| 5 | Outbound secret exfiltration | message_sending |
| 6 | Malicious skill supply chain | after_tool_call (audit) |
| 7 | Memory/context poisoning | before_tool_call |
| 8 | Credential exposure | message_sending |
| 9 | Cross-tenant leakage | Tenant-scoped policies |
| 10 | Workspace boundary bypass | before_tool_call |

## Guardrails

- All policies are evaluated server-side by AxonFlow, not locally.
- `highRiskTools` require human approval only after AxonFlow allows the tool call. If AxonFlow blocks the tool, it stays blocked.
- The plugin verifies AxonFlow connectivity on startup.
- Tool result transcript scanning is pending async hook support in OpenClaw (openclaw/openclaw#58558).

## Licensing

- **AxonFlow platform** (getaxonflow/axonflow): BSL 1.1 (Business Source License). Source-available, not open source.
- **@axonflow/openclaw plugin** (getaxonflow/axonflow-openclaw-plugin): MIT. Free to use, modify, and redistribute.
- **This uploaded ClawHub skill bundle**: MIT-0 per ClawHub terms.
