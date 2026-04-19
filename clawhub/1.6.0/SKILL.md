---
name: governance-policies
description: Govern OpenClaw with AxonFlow — block dangerous commands, detect PII, prevent data exfiltration, protect agent config files, explain policy decisions, grant time-bounded overrides with mandatory justification. Use when hardening an OpenClaw deployment, debugging a policy block, or setting up compliance-grade audit trails.
homepage: https://github.com/getaxonflow/axonflow-openclaw-plugin/tree/main/policies
tags: agent-security, approvals, audit, compliance, data-loss-prevention, explainability, governance, human-in-the-loop, llm-governance, mcp, openclaw, overrides, pii, policies, prompt-injection, safety, security, sqli
---

# AxonFlow Governance Policies for OpenClaw

Use this skill when setting up, hardening, or operating an OpenClaw deployment with AxonFlow governance. It covers self-hosting AxonFlow, plugin installation, policy configuration, understanding why a tool call was blocked, granting a time-bounded override with mandatory justification, and building compliance-grade audit trails.

**AxonFlow is self-hosted.** It runs on your infrastructure via Docker Compose. All policy evaluation, PII detection, and audit logging happens on your own AxonFlow instance. Credentials are only needed for enterprise mode — community mode requires no auth. An anonymous startup ping (version and basic deployment info) is sent by default for local, self-hosted, and remote deployments. Opt out globally with `DO_NOT_TRACK=1` or `AXONFLOW_TELEMETRY=off`.

## When to use this skill

- Setting up OpenClaw with AxonFlow for the first time.
- A tool call got blocked and you want to know **why**.
- You need to **allow** a specific blocked action for a short, audited window.
- You are auditing agent behavior for compliance.
- You are configuring per-user identity so AxonFlow attributes decisions correctly.
- You are hardening an OpenClaw deployment against reverse shells, SSRF, PII leakage, or agent-config poisoning.

## Self-Host AxonFlow

AxonFlow runs locally via Docker Compose. No LLM provider keys required — OpenClaw handles all LLM calls, AxonFlow only enforces policies and records audit trails.

**Prerequisites:** Docker Engine or Desktop, Docker Compose v2, 4 GB RAM, 10 GB disk.

**Quick start:** Clone the [AxonFlow community repo](https://github.com/getaxonflow/axonflow), copy `.env.example` to `.env`, and run `docker compose up -d`. The Agent starts on port 8080 — all SDK and plugin traffic goes through this port.

Full setup instructions: [Self-Hosted Deployment Guide](https://docs.getaxonflow.com/docs/deployment/self-hosted/)

## Install the Plugin

```bash
openclaw plugins install @axonflow/openclaw
```

The `clawhub:@axonflow/openclaw` form also works.

Requires OpenClaw **2026.4.14 or later** and `@axonflow/openclaw` **1.3.1 or later** (for `X-User-Email` forwarding on override endpoints). Upgrade the CLI with `npm install -g openclaw@latest`.

> **Note on the package name:** the npm package is `@axonflow/openclaw`, not `@axonflow/openclaw-plugin`. The repo name differs from the package name.

## Configure

Configure the plugin with your AxonFlow endpoint, credentials, and per-user identity:

```
endpoint:          http://localhost:8080           # AxonFlow agent gateway
clientId:          community                        # or your enterprise client id (defaults to "community")
clientSecret:      ""                               # leave empty in community mode; set in enterprise mode
userEmail:         alice@example.com                # required for override + explain endpoints (v1.3.1+)
highRiskTools:     [web_fetch, exec]                # tools requiring human approval on allow
onError:           block                            # fail-closed in production, or "allow" for dev
requestTimeoutMs:  8000                             # raise when AxonFlow is remote/VPN
```

In community mode, `clientId` defaults to `"community"` and `clientSecret` can be left empty — no credentials needed for the local developer flow. In enterprise mode, provide OAuth2 Client Credentials (Basic auth) matching your tenant. Setting `clientSecret` without `clientId` is rejected by the config resolver — licensed mode must specify both.

**`userEmail` (new in v1.3.1):** per-user identity forwarded via the `X-User-Email` header. Required for `client.createOverride()`, `client.revokeOverride()`, `client.listOverrides()` (endpoints reject unauthenticated user identity with HTTP 401) and for correct per-user scoping on `client.explainDecision()`. If unset the client still works for block-path features but override lifecycle methods return 401.

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

## Understand a Block: Richer Context (v1.3.0+)

When AxonFlow blocks a tool call against platform v7.1.0 or later, the plugin surfaces structured context instead of a terse "policy violation" string. The block response carries:

- **`decision_id`** — unique ID pinning the block to an audit row. Use it to fetch the full explanation or reference it in a support conversation.
- **`risk_level`** — `low` / `medium` / `high` / `critical` (highest severity wins across matched policies).
- **`policy_matches[]`** — every policy that matched, with `policy_id`, `policy_name`, `action`, `risk_level`, `allow_override`, and `policy_description` so the agent can render a specific reason instead of a generic block message.
- **`override_available`** — true when at least one matched policy is overridable (non-critical, `allow_override=true`).
- **`override_existing_id`** — set when the caller already has a live override on the blocking policy (check before creating a new one).

The hook stderr also carries a machine-readable suffix like `[decision: <id>, risk: <level>, active override: <id>]` or a pointer to `client.explainDecision(id)` when no active override exists.

## Explain a Decision

Fetch the full explanation for any previously-made decision:

```ts
import { AxonFlowClient } from '@axonflow/openclaw';
const client = new AxonFlowClient({ endpoint, clientId, clientSecret, userEmail });

const explanation = await client.explainDecision(decisionId);
// DecisionExplanation: { decision, reason, risk_level, policy_matches, matched_rules,
//                       override_available, override_existing_id,
//                       historical_hit_count_session, tool_signature, policy_source_link }
```

The shape is frozen per the explainability data contract (ADR-043). Access is scoped to the decision owner or same-tenant callers. Returns `null` on 404 or network failure so callers can fall back to a terse block message without crashing. See [Explainability](https://docs.getaxonflow.com/docs/governance/explainability/).

## Grant a Session Override

For a policy that `allow_override=true` and is not critical-risk, grant a time-bounded override with mandatory free-text justification:

```ts
const override = await client.createOverride({
  policyId:       'sys_dangerous_shell_download',   // UUID or slug — both accepted
  policyType:     'static',                          // or 'dynamic'
  overrideReason: 'Approved by security — scripted install for pinned deployment',
  toolSignature:  'openclaw.exec:bash-script',       // optional: scope to one tool
  ttlSeconds:     1800,                              // optional: clamped to [60s, 24h], default 60m
});
// CreateOverrideResult: { id, policy_id, policy_type, expires_at, ttl_seconds,
//                         requested_ttl?, clamped?, clamped_reason?, created_at }
```

**Platform-enforced invariants** (per the session-override semantics contract):
- TTL clamped to [1 min, 24 h]; default 60 min.
- Critical-risk policies are never overridable — a DB trigger rejects the create with HTTP 403.
- `allow_override=false` policies rejected with HTTP 403.
- `overrideReason` is mandatory and captured on the audit row.
- Four audit events per override lifecycle: `override_created`, `override_used`, `override_expired`, `override_revoked`.

```ts
await client.revokeOverride(override.id);
const active = await client.listOverrides({ policyId, includeRevoked: false });
```

See [Session Overrides](https://docs.getaxonflow.com/docs/governance/overrides/).

## OpenClaw-Specific Hardening

For additional protection against OpenClaw-specific attack vectors, the plugin repository includes ready-to-use policy templates:

```
Command execution  → reverse shells, destructive filesystem ops, credential file access
SSRF prevention    → cloud metadata endpoints, internal network addresses
Agent config       → SOUL.md, MEMORY.md, identity file write protection
Path traversal     → workspace escape patterns
```

Full policy templates: [Starter Policies](https://github.com/getaxonflow/axonflow-openclaw-plugin/tree/main/policies)

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

## Common Workflows

### Debug a block

1. Agent hits a block; capture `decision_id` from the block reason string.
2. Call `client.explainDecision(decisionId)` to get the full reason, matched policies, risk level, and override availability.
3. If `override_available === true` and the block is genuinely a false positive for your context, either fix the policy (permanent) or create a scoped override (temporary).

### Grant a one-off allow

1. Confirm the policy matched is not critical (`risk_level !== 'critical'` and `allow_override === true`).
2. Call `client.createOverride({ policyId, policyType, overrideReason, toolSignature, ttlSeconds })` with a specific justification text that will end up on the audit trail.
3. Retry the tool call; the platform re-evaluates, flips deny → allow, emits an `override_used` event.
4. Call `client.revokeOverride(id)` when the work window ends, or let the TTL expire.

### Audit a session

1. Call `client.searchAuditEvents({ startTime, endTime })` to scan tool-call records.
2. Filter the compliance-grade records by `decision_id`, `policy_name`, or `override_id` (platform v7.1.0+).
3. Each record includes user, tool, matched policies, LLM prompt/response, latency, and token usage.

## Guardrails

- All policies are evaluated server-side by AxonFlow, not locally.
- High-risk tools require human approval **only after** AxonFlow allows the tool call. If AxonFlow blocks, it stays blocked regardless of HITL configuration.
- The plugin verifies AxonFlow connectivity on startup.
- Overrides are per-user (via `userEmail`), tenant-scoped, and logged at every lifecycle event.

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
- [Explainability](https://docs.getaxonflow.com/docs/governance/explainability/) — `explainDecision()`, decision IDs, matched rules, policy source links
- [Session Overrides](https://docs.getaxonflow.com/docs/governance/overrides/) — time-bounded allow-lists with mandatory justification
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
