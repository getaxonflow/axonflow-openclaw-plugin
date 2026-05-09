---
name: governance-policies
description: Govern OpenClaw with AxonFlow — runtime policy enforcement on tool calls, PII detection, agent config protection, explainable decisions, time-bounded overrides with mandatory justification. Self-host AxonFlow Community Edition for production workloads. Use when configuring an OpenClaw deployment with governance, debugging a policy decision, or setting up compliance-grade audit trails.
homepage: https://github.com/getaxonflow/axonflow-openclaw-plugin/tree/main/policies
tags: agent-security, approvals, audit, compliance, data-loss-prevention, explainability, governance, human-in-the-loop, llm-governance, mcp, openclaw, overrides, pii, policies, prompt-injection, safety, security, sqli
---

# AxonFlow Governance Policies for OpenClaw

Use this skill when setting up, hardening, or operating an OpenClaw deployment with AxonFlow governance. It covers the recommended deployment path (self-hosted), plugin installation, policy configuration, understanding why a tool call was blocked, granting a time-bounded override with mandatory justification, and building compliance-grade audit trails.

## Deployment recommendation

This plugin checks tool calls against policy on an AxonFlow agent that you point it at via `pluginConfig.endpoint`. **For any real workload, run a self-hosted AxonFlow.** Recommended deployment options, in order of capability and commitment:

1. **[Self-host AxonFlow Community Edition](https://docs.getaxonflow.com/docs/deployment/self-hosted/)** — runs entirely on your infrastructure under the BSL 1.1 source-available license; data stays within your boundary. The recommended path for any real workload. The in-skill quick start is in [Step 1](#step-1-install-the-axonflow-platform) below.
2. **Community Edition with an [Evaluation License](https://docs.getaxonflow.com/docs/deployment/evaluation-rollout-guide/)** — for production use with real users or clients on the open core; adds production-fit limits and license-gated features. Free 90-day [evaluation license](https://getaxonflow.com/plugins/evaluation-license).
3. **[AxonFlow Enterprise](https://docs.getaxonflow.com/docs/deployment/community-to-enterprise-migration/)** — production-grade governance, regulatory-grade controls, SLOs, and contractual commitments suitable for regulated industries. Contact [hello@getaxonflow.com](mailto:hello@getaxonflow.com).

**Production setup requires `pluginConfig.endpoint`** pointing at a self-hosted AxonFlow URL (Step 1 + Step 3 below). When unset, the plugin runs in evaluation mode against the Community SaaS endpoint — intended only for early exploration before self-hosting. See the [Community SaaS](https://docs.getaxonflow.com/docs/deployment/community-saas/) page for the evaluation-mode scope and limits.

Setting `pluginConfig.endpoint` to a self-hosted AxonFlow URL puts the plugin into self-hosted mode — no env var is required. Get the AxonFlow platform from [getaxonflow/axonflow](https://github.com/getaxonflow/axonflow) and follow the [Getting Started](https://docs.getaxonflow.com/docs/getting-started/) guide. For air-gapped environments where AxonFlow is not yet reachable but you want to suppress the Community SaaS evaluation fallback, set `AXONFLOW_COMMUNITY_SAAS=0`; set `AXONFLOW_TELEMETRY=off` to also disable the anonymous 7-day heartbeat.

LLM provider keys never leave the user's machine in any mode — OpenClaw makes the LLM calls; AxonFlow only enforces policies and records audit trails.

## When to use this skill

- Setting up OpenClaw with AxonFlow for the first time.
- A tool call got blocked and you want to know **why**.
- You need to **allow** a specific blocked action for a short, audited window.
- You are auditing agent behavior for compliance.
- You are configuring per-user identity so AxonFlow attributes decisions correctly.
- You are hardening an OpenClaw deployment against reverse shells, SSRF, PII leakage, or agent-config poisoning.

## Install

This is a **three-step** install: stand up the AxonFlow platform, add the plugin to OpenClaw, then point the plugin at the platform. The plugin alone does not enforce policy — it is a thin client that talks to an AxonFlow agent gateway. If the platform is not installed and reachable, governed tool calls have nothing to check against. **Skipping Step 3 is the most common mistake**: the platform is running locally but the plugin still falls back to Community SaaS because no endpoint is configured.

### Step 1: install the AxonFlow platform

For any real workload, run AxonFlow on your own infrastructure via Docker Compose. This is the recommended path for the plugin:

```bash
git clone https://github.com/getaxonflow/axonflow.git
cd axonflow && docker compose up -d

# verify
curl -s http://localhost:8080/health | jq .
```

Follow the [Getting Started](https://docs.getaxonflow.com/docs/getting-started/) guide for prerequisites (Docker Engine or Desktop, Docker Compose v2, 4 GB RAM, 10 GB disk) and the [Self-Hosted Deployment Guide](https://docs.getaxonflow.com/docs/deployment/self-hosted/) for production options. The agent gateway listens on port 8080 — all SDK and plugin traffic goes through this port.

> If you skip this step, the plugin runs in evaluation mode against the [Community SaaS](https://docs.getaxonflow.com/docs/deployment/community-saas/) endpoint — intended only for early exploration. **Do not skip Step 1 for production** — see the [Deployment recommendation](#deployment-recommendation) above.

### Step 2: install the plugin

```bash
openclaw plugins install @axonflow/openclaw@latest
```

We recommend the npm-spec form as the primary install path. npm is our source-of-truth registry; the `clawhub:@axonflow/openclaw` form also works.

Requires OpenClaw **2026.4.15 or later** (CVE floor) and `@axonflow/openclaw` **2.4.0 or later** — the recommended stable floor for the v2.x line. Upgrade the CLI with `npm install -g openclaw@latest` and the plugin with `openclaw plugins install @axonflow/openclaw@latest`. Staying on the latest plugin patch is recommended — security and quality fixes ship monthly under the v2.x line.

> **Note on the package name:** the npm package is `@axonflow/openclaw`, not `@axonflow/openclaw-plugin`. The repo name differs from the package name.

### Step 3: point the plugin at the platform

Without this step the plugin auto-registers with Community SaaS regardless of whether you ran Step 1 — it does not auto-detect a locally-running AxonFlow. Set `pluginConfig.endpoint` (and `clientId` / `clientSecret` if you have them):

```yaml
# openclaw.config.yaml
plugins:
  "@axonflow/openclaw":
    endpoint: http://localhost:8080  # or your remote AxonFlow URL
    # clientId + clientSecret are required for Evaluation License or Enterprise tenants
```

Every plugin init logs a one-line canary on stderr confirming the active mode:

```
[AxonFlow] Connected to AxonFlow at http://localhost:8080 (mode=self-hosted)
```

If the canary says `mode=community-saas` after you ran Step 1, the plugin is still hitting `try.getaxonflow.com` because Step 3 was skipped or `pluginConfig.endpoint` is unset. Fix Step 3 and reload.

Skipping Step 3 entirely (and Step 1) leaves the plugin in evaluation mode against the Community SaaS endpoint — intended only for early exploration; see the [Deployment recommendation](#deployment-recommendation) above. The first-load disclosure banner stamps under `$AXONFLOW_CONFIG_DIR`; remove the stamp file to re-display.

## Mode-specific reference

The recommended self-hosted path is covered in [Install Step 1](#step-1-install-the-axonflow-platform). The two subsections below add detail for the Community SaaS exploration path and the air-gapped opt-out path.

### Community SaaS — for early exploration only

The plugin's zero-config starting point when [Step 3](#step-3-point-the-plugin-at-the-platform) is skipped. The plugin registers a tenant with `try.getaxonflow.com` on first load and persists credentials at `$AXONFLOW_CONFIG_DIR/try-registration.json` (mode `0600`).

**Use only for early exploration of the plugin's behaviour. Not for production workloads, regulated environments, or sensitive data.** It is shared infrastructure with rate limits and no production guarantees.

For complete details on the Community SaaS scope and limits, see the [Community SaaS](https://docs.getaxonflow.com/docs/deployment/community-saas/) page in the docs.

### Air-gapped: zero outbound

For environments where no outbound traffic is permitted at all — air-gapped labs, regulated networks, classified deployments — set both env vars before the OpenClaw process starts:

```bash
export AXONFLOW_COMMUNITY_SAAS=0   # disable Community SaaS auto-bootstrap
export AXONFLOW_TELEMETRY=off      # disable the anonymous 7-day heartbeat
```

…and configure `pluginConfig.endpoint` to a self-hosted AxonFlow on the same network. With both env vars set and a same-network endpoint configured, no traffic leaves the environment.

## Configure

[Step 3](#step-3-point-the-plugin-at-the-platform) covers the primary keys (`endpoint` / `clientId` / `clientSecret`). Two more `pluginConfig` keys are worth highlighting:

- **`userEmail`** — per-user identity, forwarded as the `X-User-Email` header. **Required** for `client.createOverride()`, `client.revokeOverride()`, `client.listOverrides()` (the endpoints reject calls without user identity, returning HTTP 401), and for correct per-user scoping on `client.explainDecision()`. If unset the client still works for block-path features but override lifecycle methods return 401.
- **`clientSecret`** handling — **resolve at runtime from a secret store** (Vault, AWS Secrets Manager, GCP Secret Manager, or your CI provider's secret store) rather than embedding the value in a config file checked into source control. The config resolver rejects `clientSecret` set without `clientId` — licensed mode must specify both.

Optional `pluginConfig` keys: `highRiskTools` (tools requiring human approval after AxonFlow allows), `onError` (`block` for fail-closed in production, `allow` for dev), `requestTimeoutMs` (raise when AxonFlow is remote/VPN), `governedTools` / `excludedTools` (scope which tools the plugin governs), `defaultOperation` (`execute` or `query` for `mcp_check_input`).

Full configuration reference: [OpenClaw Integration Guide](https://docs.getaxonflow.com/docs/integration/openclaw/).

## Plugin Pro tier — extended retention and quota on Community SaaS

Plugin Pro is the paid tier for the Community SaaS endpoint. It extends the Free baseline (3-day audit retention, 200 governed events / day, 2 active custom policies, 1 HITL approval per rolling 7d) to 30-day retention, 2,000 events / day, unlimited active custom policies, unlimited HITL approvals, and adds the LLM cost pre-flight tool (estimate token cost for a multi-step plan before it runs). 90-day window, one-time payment, no auto-renewal, 14-day refund window. Self-hosted deployments don't need Plugin Pro — their tier and limits are governed by their own license.

Pricing and the buy flow are documented at [getaxonflow.com/pricing](https://getaxonflow.com/pricing/). Per-plugin install instructions for the issued license token are at [docs.getaxonflow.com/pro](https://docs.getaxonflow.com/pro/).

### Find the tenant ID before checkout

Plugin Pro is bound to a tenant. The tenant ID (a `cs_<uuid>` string) is paste-copied into the Stripe Checkout custom field labelled "AxonFlow tenant ID" so the issuer knows which tenant to bind the license to. Run the bundled CLI from the user's terminal to surface it:

```bash
npx @axonflow/openclaw axonflow-openclaw-status
```

The status CLI prints the tenant ID, the resolved AxonFlow endpoint, the current tier, and a redacted preview of any configured license token. The full token is never printed — only the trailing 4 chars — so the output is safe to screen-share or paste into a support thread. JSON output is available via `--json` for piping into `jq`.

### Activate Pro after checkout

After Stripe Checkout completes, the issuer emails an `AXON-...` license token. To activate Pro on this plugin install, set either:

- the `AXONFLOW_LICENSE_TOKEN` environment variable in the OpenClaw process environment, or
- the `licenseToken` field under the plugin's entry in `openclaw.config.yaml`.

Reload OpenClaw. Every plugin init logs an `[AxonFlow] Pro tier active …` canary alongside the existing connection canary, and the plugin forwards `X-License-Token` on every governed request automatically. The agent's plugin-claim middleware validates the token and applies Pro-tier entitlements (extended retention, higher quota). When the 90-day window ends, the tenant returns to Free; re-purchase to continue Pro.

### Recover lost credentials with the bundled CLI

If the user loses the auto-bootstrapped Community SaaS credential file (`$AXONFLOW_CONFIG_DIR/try-registration.json`) and registered with an email, the plugin ships a recovery CLI that drives the platform's email-based recovery flow:

```bash
npx @axonflow/openclaw axonflow-openclaw-recover you@example.com
```

The CLI posts the email to `/api/v1/recover` (the platform always returns 202 — anti-enumeration; no signal whether the email is bound), prompts the user to paste the magic-link token from the email they receive, posts to `/api/v1/recover/verify`, and persists the freshly issued tenant ID + secret to the config file (mode `0600`). Magic-link tokens are one-shot and short-lived; replays return 401. Reload OpenClaw and the next governed call uses the recovered registration.

## Environment variables

| Variable | Effect |
|---|---|
| `AXONFLOW_TELEMETRY=off` | Disables the 7-day anonymous heartbeat to `checkpoint.getaxonflow.com`. Accepted off-values: `off`, `0`, `false`, `no`. **Scope:** the heartbeat opt-out is meaningful on self-hosted / in-VPC deployments where the heartbeat is the only data the plugin sends. On Community SaaS (`try.getaxonflow.com`) the hosted service also processes operational data (registrations, audit logs, policy enforcement records, workflow state, plan data, request-header metadata aggregated for usage analytics) as part of running the platform; that flow is governed by the [Privacy Policy](https://getaxonflow.com/privacy/), not by this env var. |
| `AXONFLOW_COMMUNITY_SAAS=0` | Disables auto-registration with `try.getaxonflow.com`. You must then set `pluginConfig.endpoint` for the plugin to enforce policy. Accepted off-values: `0`, `false`, `off`, `no`. |
| `AXONFLOW_CACHE_DIR` | Overrides the per-user cache directory used for telemetry stamps and rate-limit backoffs. Defaults to OS conventions: `$XDG_CACHE_HOME/axonflow` on Linux, `~/Library/Caches/axonflow` on macOS, `%LOCALAPPDATA%\axonflow` on Windows. |
| `AXONFLOW_CONFIG_DIR` | Overrides the per-user config directory used for the Community-SaaS registration file (mode `0600`). Defaults to OS conventions: `$XDG_CONFIG_HOME/axonflow` on Linux, `~/Library/Application Support/axonflow` on macOS, `%APPDATA%\axonflow` on Windows. |
| `AXONFLOW_LICENSE_TOKEN` | Plugin Pro license token (begins with `AXON-`). When set, the plugin sends `X-License-Token` on every governed request and the agent applies Pro-tier entitlements. Wins over `pluginConfig.licenseToken`. Empty / whitespace-only values are treated as unset. |
| `AXONFLOW_UPGRADE_URL` | Overrides the upgrade URL surfaced by `axonflow-openclaw-status` to free-tier users. Defaults to `https://getaxonflow.com/pricing/`. |

The legacy `DO_NOT_TRACK=1` opt-out was removed in plugin v2.0.0; `AXONFLOW_TELEMETRY=off` is the canonical and only telemetry opt-out.

## What's Protected Automatically

AxonFlow's 80+ built-in system policies apply with no additional setup:

- **Dangerous command blocking** — 10 policies covering destructive operations, remote code execution, credential access, cloud metadata, path traversal
- **SQL injection** — 30+ detection patterns covering advanced injection techniques
- **PII detection and redaction** — SSN, credit card, email, phone, Aadhaar, PAN, NRIC/FIN (Singapore)
- **Code security** — API keys, connection strings, hardcoded secrets, unsafe code patterns
- **Prompt manipulation** — instruction override and context manipulation attempts

Examples of blocked patterns (all checked server-side by AxonFlow):

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

> **Plugin v2.4.0+:** the operations below are also exposed to the OpenClaw agent as registered tools, all scoped to the caller's tenant and tier. Eleven tools total, split into two groups:
>
> - **Read-side governance** (6) — surface the caller's own decision and override state: `axonflow_explain_decision`, `axonflow_list_recent_decisions` (NEW in v2.4.0 — paginated recent decisions; Free 5 / 24h, Pro 100 / 30d), `axonflow_list_overrides`, `axonflow_create_override`, `axonflow_revoke_override`, `axonflow_audit_search`. Override creation is gated by platform invariants (TTL clamped to [60s, 24h], mandatory free-text justification, critical-risk policies non-overridable; see [Grant a Session Override](#grant-a-session-override) below).
> - **Plugin Pro toolset** (5, cross-plugin parity): `axonflow_get_tenant_id` (tenant_id + current tier + upgrade URLs — answers "what's my tenant ID?" or "am I on Pro?" inline without spawning a shell), `axonflow_list_pro_features` (locked Pro feature list — visible to all tiers), `axonflow_request_approval` (request human-in-the-loop approval before risky operations; Free tier 1 / rolling 7d, Pro unlimited), `axonflow_create_tenant_policy` (create a custom tenant-scoped policy; Free tier 2 active max, Pro unlimited), and `axonflow_get_cost_estimate` (LLM cost pre-flight for a multi-step plan; Pro-only — visible to Pro callers, returns the upgrade envelope to Free callers).
>
> The read-side methods are also available as client methods documented below; see [Explainability](https://docs.getaxonflow.com/docs/governance/explainability/) for the full wire-shape contract.

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
3. Retry the tool call; the platform re-checks against the matched policies, flips deny → allow, emits an `override_used` event.
4. Call `client.revokeOverride(id)` when the work window ends, or let the TTL expire.

### Audit a session

1. Call `client.searchAuditEvents({ startTime, endTime })` to scan tool-call records.
2. Filter the compliance-grade records by `decision_id`, `policy_name`, or `override_id` (platform v7.1.0+).
3. Each record includes user, tool, matched policies, LLM prompt/response, latency, and token usage.

## Guardrails

- All policies are checked server-side by AxonFlow, not locally.
- High-risk tools require human approval **only after** AxonFlow allows the tool call. If AxonFlow blocks, it stays blocked regardless of HITL configuration.
- The plugin verifies AxonFlow connectivity on startup.
- Overrides are per-user (via `userEmail`), tenant-scoped, and logged at every lifecycle event.

## Learn More

**Get Started**
- [Getting Started](https://docs.getaxonflow.com/docs/getting-started/) — quickstart for new users
- [Community SaaS](https://docs.getaxonflow.com/docs/deployment/community-saas/) — zero-config exploration endpoint, scope and limits
- [Self-Hosted Deployment](https://docs.getaxonflow.com/docs/deployment/self-hosted/) — Docker Compose, prerequisites, production options
- [OpenClaw Integration Guide](https://docs.getaxonflow.com/docs/integration/openclaw/) — full plugin setup walkthrough

**Policies & Security**
- [Security Best Practices](https://docs.getaxonflow.com/docs/security/best-practices/) — hardening guide for production deployments
- [Policy Enforcement](https://docs.getaxonflow.com/docs/mcp/policy-enforcement/) — how policies are applied at runtime
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
