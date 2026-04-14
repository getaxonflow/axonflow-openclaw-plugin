---
name: governance-policies
description: Set up governance policies for OpenClaw — block dangerous commands, detect PII, prevent data exfiltration, protect agent config files. Use when hardening an OpenClaw deployment with AxonFlow.
homepage: https://github.com/getaxonflow/axonflow-openclaw-plugin/tree/main/policies
tags: security, governance, pii, compliance, openclaw, audit
---

# AxonFlow Governance Policies for OpenClaw

Use when setting up or hardening an OpenClaw deployment with AxonFlow governance. This skill covers self-hosting AxonFlow, plugin installation, policy configuration, and risk mitigation.

**AxonFlow is self-hosted.** It runs on your infrastructure via Docker Compose. All policy evaluation, PII detection, and audit logging happens on your own AxonFlow instance. Credentials are only needed for enterprise mode — community mode requires no auth. An anonymous startup ping (version and basic deployment info) is sent by default for local, self-hosted, and remote deployments. Opt out globally with `DO_NOT_TRACK=1` or `AXONFLOW_TELEMETRY=off`.

## Self-Host AxonFlow

AxonFlow runs locally via Docker Compose. No LLM provider keys required — OpenClaw handles all LLM calls, AxonFlow only enforces policies and records audit trails.

**Prerequisites:** Docker Engine or Desktop, Docker Compose v2, 4 GB RAM, 10 GB disk.

**Quick start:** Clone the [AxonFlow community repo](https://github.com/getaxonflow/axonflow), copy `.env.example` to `.env`, and run `docker compose up -d`. The Agent starts on port 8080 — all SDK and plugin traffic goes through this port.

Full setup instructions: [Self-Hosted Deployment Guide](https://docs.getaxonflow.com/docs/deployment/self-hosted/)

## Install the Plugin

Install via OpenClaw's plugin manager and configure in your OpenClaw config with your AxonFlow endpoint, credentials, high-risk tool list, and optional `requestTimeoutMs` override. Set `onError: block` for production (fail-closed) or `allow` for development (fail-open). Increase `requestTimeoutMs` above the default 8000ms when AxonFlow is running remotely or behind a slow VPN.

In community mode, `clientId` and `clientSecret` default to `"community"` — no credentials needed for the local developer flow. In enterprise mode, provide OAuth2 Client Credentials (Basic auth). The `tenantId` config field has been removed — tenant is derived server-side from credentials.

Full configuration reference: [OpenClaw Integration Guide](https://docs.getaxonflow.com/docs/integration/openclaw/)

## What's Protected Automatically

AxonFlow's 80+ built-in system policies apply with no additional setup:

- **Dangerous command blocking** — 10 policies covering destructive operations, remote code execution, credential access, cloud metadata, path traversal
- **SQL injection** — 30+ detection patterns covering advanced injection techniques
- **PII detection and redaction** — SSN, credit card, email, phone, Aadhaar, PAN, NRIC/FIN (Singapore)
- **Code security** — API keys, connection strings, hardcoded secrets, unsafe code patterns
- **Prompt manipulation** — instruction override and context manipulation attempts

Examples of blocked patterns (all evaluated server-side by AxonFlow):

```
rm -rf /          → blocked by sys_dangerous_destructive_fs
curl ... | sh     → blocked by sys_dangerous_shell_download
nc -e /bin/bash   → blocked by sys_dangerous_reverse_shell
169.254.169.254   → blocked by sys_dangerous_cloud_metadata
cat ~/.ssh/id_rsa → blocked by sys_dangerous_credential_access
../../etc/passwd  → blocked by sys_dangerous_path_traversal
```

## OpenClaw-Specific Hardening

For additional protection against OpenClaw-specific attack vectors, the plugin repository includes ready-to-use policy templates:

```
Command execution  → reverse shells, destructive filesystem ops, credential file access
SSRF prevention    → cloud metadata endpoints, internal network addresses
Agent config       → SOUL.md, MEMORY.md, identity file write protection
Path traversal     → workspace escape patterns
```

Full policy templates with SQL examples: [Starter Policies](https://github.com/getaxonflow/axonflow-openclaw-plugin/tree/main/policies)

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
- High-risk tools require human approval only after AxonFlow allows the tool call. If AxonFlow blocks the tool, it stays blocked.
- The plugin verifies AxonFlow connectivity on startup.

## Learn More

**Get Started**
- [Getting Started](https://docs.getaxonflow.com/docs/getting-started/) — quickstart for new users
- [OpenClaw Integration Guide](https://docs.getaxonflow.com/docs/integration/openclaw/) — full plugin setup walkthrough
- [Self-Hosted Deployment](https://docs.getaxonflow.com/docs/deployment/self-hosted/) — Docker Compose, prerequisites, production options

**Policies & Security**
- [Security Best Practices](https://docs.getaxonflow.com/docs/security/best-practices/) — hardening guide for production deployments
- [Policy Enforcement](https://docs.getaxonflow.com/docs/mcp/policy-enforcement/) — how policies are evaluated at runtime
- [Policy Syntax](https://docs.getaxonflow.com/docs/policies/syntax/) — writing custom regex and rule-based policies
- [System Policies](https://docs.getaxonflow.com/docs/policies/system-policies/) — 80+ built-in policies (PII, SQLi, secrets, dangerous commands, prompt injection)
- [PII Detection](https://docs.getaxonflow.com/docs/security/pii-detection/) — SSN, credit card, Aadhaar, PAN, email, phone detection and redaction
- [Response Redaction](https://docs.getaxonflow.com/docs/mcp/response-redaction/) — how outbound content is scanned and redacted

**Governance & Compliance**
- [Audit Logging](https://docs.getaxonflow.com/docs/governance/audit-logging/) — compliance-grade audit trails for every tool call and LLM interaction
- [Human-in-the-Loop](https://docs.getaxonflow.com/docs/governance/human-in-the-loop/) — approval gates for high-risk operations
- [HITL Approval Gates](https://docs.getaxonflow.com/docs/features/hitl-approval-gates/) — configuring approval workflows
- [Cost Management](https://docs.getaxonflow.com/docs/governance/cost-management/) — token budgets, rate limits, cost controls
- [Compliance Frameworks](https://docs.getaxonflow.com/docs/compliance/overview/) — EU AI Act, MAS FEAT, RBI, SEBI templates

**Platform & Examples**
- [Feature Overview](https://docs.getaxonflow.com/docs/features/overview/) — full platform capabilities
- [Community vs Enterprise](https://docs.getaxonflow.com/docs/features/community-vs-enterprise/) — what's available in each tier
- [Workflow Examples](https://docs.getaxonflow.com/docs/tutorials/workflow-examples/) — multi-step governance workflows and advanced patterns
- [Banking Example](https://docs.getaxonflow.com/docs/examples/banking/) — financial services governance patterns
- [Healthcare Example](https://docs.getaxonflow.com/docs/examples/healthcare/) — HIPAA-aware agent governance
- [E-commerce Example](https://docs.getaxonflow.com/docs/examples/ecommerce/) — customer-facing agent policies

**Source Code**
- [Plugin Source](https://github.com/getaxonflow/axonflow-openclaw-plugin) — MIT licensed
- [AxonFlow Community](https://github.com/getaxonflow/axonflow) — source-available under BSL 1.1

## Licensing

- **AxonFlow platform** (getaxonflow/axonflow): BSL 1.1 (Business Source License). Source-available, not open source.
- **@axonflow/openclaw plugin** (getaxonflow/axonflow-openclaw-plugin): MIT. Free to use, modify, and redistribute.
- **This skill**: MIT-0 per ClawHub terms.
