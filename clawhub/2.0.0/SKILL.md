---
name: governance-policies
description: Govern OpenClaw with AxonFlow — block dangerous commands, detect PII, prevent data exfiltration, protect agent config files, explain policy decisions, grant time-bounded overrides with mandatory justification. Default Community SaaS for one-command evaluation, self-host for production. Use when hardening an OpenClaw deployment, debugging a policy block, or setting up compliance-grade audit trails.
homepage: https://github.com/getaxonflow/axonflow-openclaw-plugin/tree/main/policies
tags: agent-security, approvals, audit, compliance, data-loss-prevention, explainability, governance, human-in-the-loop, llm-governance, mcp, openclaw, overrides, pii, policies, prompt-injection, safety, security, sqli
---

# AxonFlow Governance Policies for OpenClaw

Use this skill when setting up, hardening, or operating an OpenClaw deployment with AxonFlow governance. It covers the three deployment modes (Community SaaS default, self-hosted, air-gapped), plugin installation, policy configuration, understanding why a tool call was blocked, granting a time-bounded override with mandatory justification, and building compliance-grade audit trails.

**Three deployment modes.** Plugin v2.0.0+ defaults to **Community SaaS** — `openclaw plugins install @axonflow/openclaw` auto-registers with `try.getaxonflow.com` on first load and starts governing tool calls without any further configuration. For real workloads or sensitive data, point the plugin at a **self-hosted** AxonFlow instance you run via Docker Compose. For air-gapped operation, opt out of Community SaaS auto-registration with `AXONFLOW_COMMUNITY_SAAS=0` and the 7-day anonymous heartbeat with `AXONFLOW_TELEMETRY=off`. LLM provider keys never leave the user's machine in any mode — OpenClaw makes the LLM calls; AxonFlow only enforces policies and records audit trails.

## When to use this skill

- Setting up OpenClaw with AxonFlow for the first time.
- A tool call got blocked and you want to know **why**.
- You need to **allow** a specific blocked action for a short, audited window.
- You are auditing agent behavior for compliance.
- You are configuring per-user identity so AxonFlow attributes decisions correctly.
- You are hardening an OpenClaw deployment against reverse shells, SSRF, PII leakage, or agent-config poisoning.

## Install the Plugin

```bash
openclaw plugins install @axonflow/openclaw
```

The `clawhub:@axonflow/openclaw` form also works.

Requires OpenClaw **2026.4.15 or later** (CVE floor) and `@axonflow/openclaw` **2.0.0 or later**. Upgrade the CLI with `npm install -g openclaw@latest`.

> **Note on the package name:** the npm package is `@axonflow/openclaw`, not `@axonflow/openclaw-plugin`. The repo name differs from the package name.

After install, the plugin auto-registers with Community SaaS on first load and emits a one-time disclosure banner via the OpenClaw plugin logger before the registration POST fires. Banner stamp is written under `$AXONFLOW_CONFIG_DIR`; remove the stamp file to re-display.

## Deployment Modes

### Default: AxonFlow Community SaaS

Zero-config evaluation path. Install the plugin, do not set `pluginConfig.endpoint`, and the plugin registers a tenant with `try.getaxonflow.com` on first load and persists credentials at `$AXONFLOW_CONFIG_DIR/try-registration.json` (mode `0600`). All policy evaluation, PII detection, and audit logging runs against the shared Community SaaS instance.

What goes off-host on each governed call: tool name + arguments before execution, outbound message bodies before delivery (PII/secret scan), and an anonymous 7-day heartbeat (plugin version, OS, runtime). What does **not** go off-host: LLM provider API keys, OpenClaw conversation history outside governed tools, or any data outside the OpenClaw runtime.

Community SaaS is intended for evaluation and prototyping. It has no SLA, no production guarantees, runs against shared Ollama models, and rate-limits at 20 req/min · 500 req/day per tenant. Read the [Try AxonFlow — Free Trial Server](https://docs.getaxonflow.com/docs/deployment/community-saas/) page for the full disclosure, including data retention and registration mechanics.

### Self-hosted: your own AxonFlow

Recommended for any real workflow, real systems, or sensitive data. Run AxonFlow yourself via Docker Compose; nothing leaves your network except the anonymous 7-day heartbeat. Point the plugin at your endpoint via `pluginConfig.endpoint` and provide the matching `clientId` / `clientSecret` issued to your tenant.

**Prerequisites:** Docker Engine or Desktop, Docker Compose v2, 4 GB RAM, 10 GB disk.

**Quick start:** Clone the [AxonFlow community repo](https://github.com/getaxonflow/axonflow), copy `.env.example` to `.env`, and run `docker compose up -d`. The agent gateway starts on port 8080 — all SDK and plugin traffic goes through this port.

Full setup: [Self-Hosted Deployment Guide](https://docs.getaxonflow.com/docs/deployment/self-hosted/).

### Air-gapped: zero outbound

For environments where no outbound traffic is permitted at all — air-gapped labs, regulated networks, classified deployments — set both env vars before the OpenClaw process starts:

```bash
export AXONFLOW_COMMUNITY_SAAS=0   # disable Community SaaS auto-bootstrap
export AXONFLOW_TELEMETRY=off      # disable the anonymous 7-day heartbeat
```

…and configure `pluginConfig.endpoint` to a self-hosted AxonFlow on the same network. With both env vars set and a same-network endpoint configured, no traffic leaves the environment.

## Configure

Configure four `pluginConfig` keys plus optional environment variables:

- **`endpoint`** — the URL of your AxonFlow agent gateway. Leave unset for Community SaaS auto-registration; set to your self-hosted AxonFlow URL for production.
- **`clientId`** — your AxonFlow tenant identifier. In Community SaaS mode, the auto-registration flow populates this. In self-hosted mode, set the tenant ID issued to your deployment.
- **`clientSecret`** — the matching secret. **Resolve at runtime from a secret store** (Vault, AWS Secrets Manager, GCP Secret Manager, or your CI provider's secret store) rather than embedding the value in a config file checked into source control. The config resolver rejects `clientSecret` set without `clientId` — licensed mode must specify both.
- **`userEmail`** — per-user identity, forwarded as the `X-User-Email` header. **Required** for `client.createOverride()`, `client.revokeOverride()`, `client.listOverrides()` (the endpoints reject calls without user identity, returning HTTP 401), and for correct per-user scoping on `client.explainDecision()`. If unset the client still works for block-path features but override lifecycle methods return 401.

Optional `pluginConfig` keys: `highRiskTools` (tools requiring human approval after AxonFlow allows), `onError` (`block` for fail-closed in production, `allow` for dev), `requestTimeoutMs` (raise when AxonFlow is remote/VPN).

Full configuration reference: [OpenClaw Integration Guide](https://docs.getaxonflow.com/docs/integration/openclaw/).

## Environment variables

| Variable | Effect |
|---|---|
| `AXONFLOW_TELEMETRY=off` | Disables the 7-day anonymous heartbeat to `checkpoint.getaxonflow.com`. Accepted off-values: `off`, `0`, `false`, `no`. |
| `AXONFLOW_COMMUNITY_SAAS=0` | Disables auto-registration with `try.getaxonflow.com`. You must then set `pluginConfig.endpoint` for the plugin to enforce policy. Accepted off-values: `0`, `false`, `off`, `no`. |
| `AXONFLOW_CACHE_DIR` | Overrides the per-user cache directory used for telemetry stamps and rate-limit backoffs. Defaults to OS conventions: `$XDG_CACHE_HOME/axonflow` on Linux, `~/Library/Caches/axonflow` on macOS, `%LOCALAPPDATA%\axonflow` on Windows. |
| `AXONFLOW_CONFIG_DIR` | Overrides the per-user config directory used for the Community-SaaS registration file (mode `0600`). Defaults to OS conventions: `$XDG_CONFIG_HOME/axonflow` on Linux, `~/Library/Application Support/axonflow` on macOS, `%APPDATA%\axonflow` on Windows. |

The legacy `DO_NOT_TRACK=1` opt-out was removed in plugin v2.0.0; `AXONFLOW_TELEMETRY=off` is the canonical and only telemetry opt-out.

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

## Understand a Block: Richer Context

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
- [Try AxonFlow — Community SaaS](https://docs.getaxonflow.com/docs/deployment/community-saas/) — zero-config evaluation, what gets sent off-host, registration mechanics, rate limits, retention
- [Self-Hosted Deployment](https://docs.getaxonflow.com/docs/deployment/self-hosted/) — Docker Compose, prerequisites, production options
- [OpenClaw Integration Guide](https://docs.getaxonflow.com/docs/integration/openclaw/) — full plugin setup walkthrough

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
