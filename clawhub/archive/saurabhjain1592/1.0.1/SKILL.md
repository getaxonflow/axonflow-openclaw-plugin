---
name: axonflow-governance-policies
description: Set up governance policies for OpenClaw — block dangerous commands, detect PII, prevent data exfiltration, protect agent config files. Use when hardening an OpenClaw deployment with AxonFlow.
homepage: https://github.com/getaxonflow/axonflow-openclaw-plugin/tree/main/policies
tags: security, governance, pii, compliance, openclaw
---

# AxonFlow Governance Policies for OpenClaw

Use when setting up or hardening an OpenClaw deployment with AxonFlow governance. This skill covers self-hosting AxonFlow, plugin installation, policy configuration, and risk mitigation.

## Self-Host AxonFlow

### Prerequisites

- Docker Engine or Docker Desktop
- Docker Compose v2
- 4 GB RAM minimum, 10 GB free disk
- At least one LLM provider key (optional, only if routing LLM calls through AxonFlow)

### Start AxonFlow

```bash
git clone https://github.com/getaxonflow/axonflow.git
cd axonflow
cp .env.example .env
# Optional: add provider keys in .env
# OPENAI_API_KEY=...
# ANTHROPIC_API_KEY=...
docker compose up -d
```

### Verify

```bash
# Check services are running
docker compose ps

# Health check
curl -s http://localhost:8080/health | jq .
```

### Services

| Service | Port | Purpose |
|---------|------|---------|
| Agent | `8080` | Main API — all requests go here |
| Orchestrator | `8081` | Internal — do not call directly |
| PostgreSQL | `5432` | Policy storage |
| Redis | `6379` | Coordination |
| Prometheus | `9090` | Metrics |
| Grafana | `3000` | Dashboards |

All SDK and plugin traffic goes through the Agent on port 8080. Never call the Orchestrator directly.

Full deployment guide: https://docs.getaxonflow.com/docs/deployment/self-hosted/

## Install the Plugin

```bash
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

In community mode (`DEPLOYMENT_MODE=community`), client auth checks are skipped for the local developer flow, so any clientId/clientSecret pair works.

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
- Tool result transcript scanning is pending async hook support in OpenClaw ([openclaw#58558](https://github.com/openclaw/openclaw/issues/58558)).

## Licensing

- **AxonFlow platform** (getaxonflow/axonflow): BSL 1.1 (Business Source License). Source-available, not open source.
- **@axonflow/openclaw plugin** (getaxonflow/axonflow-openclaw-plugin): MIT. Free to use, modify, and redistribute.
- **This uploaded ClawHub skill bundle**: MIT-0 per ClawHub terms.
