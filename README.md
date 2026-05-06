# @axonflow/openclaw

**Governance for OpenClaw agents: block dangerous tool calls, require human approval on high-risk actions, redact PII from outbound messages, and keep a compliance-grade audit trail — without changing a single line of your agent code.**

[![npm](https://img.shields.io/npm/v/%40axonflow%2Fopenclaw?color=%2300A36C)](https://www.npmjs.com/package/@axonflow/openclaw)
[![ClawHub](https://img.shields.io/badge/ClawHub-listed-00A36C)](https://clawhub.ai/plugins/%40axonflow%2Fopenclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **→ Full integration walkthrough:** **[docs.getaxonflow.com/docs/integration/openclaw](https://docs.getaxonflow.com/docs/integration/openclaw/)** — architecture, hook coverage, policy examples, and troubleshooting.

> **Upgrade strongly recommended.** AxonFlow ships substantial monthly security and quality hardening; staying on the latest major is the security-supported release line. [Latest release](https://github.com/getaxonflow/axonflow-openclaw-plugin/releases/latest) · [Security advisories](https://github.com/getaxonflow/axonflow-openclaw-plugin/security/advisories)

---

## Why this plugin exists

OpenClaw is a strong agent runtime. It is also a serious production security problem the moment you take it past a prototype:

- **[135,000+ publicly exposed instances](https://www.bitsight.com/blog/openclaw-ai-security-risks-exposed-instances)** deployed without central policy enforcement
- **[13+ CVEs disclosed in 2026](https://github.com/jgamblin/OpenClawCVEs/)**, several at CVSS 9.8+
- **[1,184 malicious skills](https://cyberpress.org/clawhavoc-poisons-openclaws-clawhub-with-1184-malicious-skills/)** poisoned in ClawHub via the ClawHavoc supply-chain attack
- **No native PII/secrets scanning**, no SQL-injection defense, no compliance-grade audit trail, no org-wide tool policy, no approval workflow

OpenClaw handles agent runtime, MCP connectivity, channels, and tool execution. It was never intended to be the place you enforce governance. This plugin adds the governance layer on top, so OpenClaw keeps doing what it does well and AxonFlow takes over the "is this allowed, should this redact, who approved, where is the audit record" questions.

**AxonFlow governs. OpenClaw orchestrates.** OpenClaw still makes every LLM call; AxonFlow only evaluates policies and records audit trails. LLM provider keys never leave your machine. Where the rest of your data goes — tool inputs, message bodies — depends on which deployment mode you pick. See **[Where your data goes](#where-your-data-goes)** below.

---

## Where your data goes

The plugin governs tool calls and outbound messages by sending each one to an AxonFlow endpoint for policy enforcement and audit. Pick the deployment mode that fits your workload:

> **Privacy notice — read before installing.** AxonFlow [Community SaaS](https://docs.getaxonflow.com/docs/deployment/community-saas/) at `try.getaxonflow.com` is the zero-config endpoint the plugin uses if no other endpoint is configured. In that mode, governed tool inputs (tool name + arguments) and outbound message bodies are checked by AxonFlow's policy enforcement endpoint. **Community SaaS is for early exploration only** — not for production workloads, regulated environments, real user data, personal data, or any other sensitive information. It is offered "as is" on a best-effort basis with no SLA, no warranties, and no commitment to retention, deletion, or incident-response timelines.
>
> For any serious use, choose one of the following instead:
>
> 1. **[Self-host AxonFlow Community Edition](https://docs.getaxonflow.com/docs/deployment/self-hosted/)** — runs entirely on your infrastructure and keeps data within your boundary. Recommended for any real workload.
> 2. **Community Edition with an [Evaluation License](https://docs.getaxonflow.com/docs/deployment/evaluation-rollout-guide/)** — for production use with real users or clients on the open core; adds production-fit limits and license-gated features. Free 90-day [evaluation license](https://getaxonflow.com/plugins/evaluation-license).
> 3. **[AxonFlow Enterprise](https://docs.getaxonflow.com/docs/deployment/community-to-enterprise-migration/)** — production-grade governance, regulatory-grade controls, SLOs, and contractual commitments suitable for regulated industries. Contact [hello@getaxonflow.com](mailto:hello@getaxonflow.com).
>
> To skip Community SaaS entirely: set `pluginConfig.endpoint` to a self-hosted AxonFlow URL. That alone flips the plugin into self-hosted mode — the Community SaaS auto-bootstrap is not attempted, and no env var is required. Get the AxonFlow platform from [getaxonflow/axonflow](https://github.com/getaxonflow/axonflow) and follow the [Getting Started](https://docs.getaxonflow.com/docs/getting-started/) guide for the Docker Compose setup. For air-gapped environments where AxonFlow is not yet reachable but you want to suppress the bootstrap attempt, set `AXONFLOW_COMMUNITY_SAAS=0`; set `AXONFLOW_TELEMETRY=off` to also disable the anonymous 7-day heartbeat.

### Self-hosted (recommended for any real use)

Point the plugin at an AxonFlow instance you run. Nothing leaves your network except the anonymous 7-day heartbeat (which can also be disabled). Configure three values in `pluginConfig`:

- `endpoint` — the URL of your AxonFlow agent gateway (for example `https://axonflow.your-corp.example.com`).
- `clientId` — the AxonFlow tenant identifier issued to your deployment.
- `clientSecret` — the matching secret. **Never commit this to source control or paste it into a config file checked into a repository.** Resolve it from a secret manager (Vault, AWS Secrets Manager, GCP Secret Manager, or your CI provider's secret store) and inject the value via your OpenClaw config templating, an environment variable consumed by your config loader, or your platform's secret-injection sidecar.

For production with real users or clients: run Community Edition with a free 90-day [Evaluation License](https://docs.getaxonflow.com/docs/deployment/evaluation-rollout-guide/) for production-fit limits and license-gated features, or [AxonFlow Enterprise](https://docs.getaxonflow.com/docs/deployment/community-to-enterprise-migration/) for regulated industries with SLOs and contractual commitments.

See the [Self-Hosted Deployment Guide](https://docs.getaxonflow.com/docs/deployment/self-hosted/) for prerequisites and production options, or the [OpenClaw Integration Guide](https://docs.getaxonflow.com/docs/integration/openclaw/) for architecture and the full pluginConfig schema.

### Community SaaS — for early exploration only

The plugin's zero-config fallback. Install the plugin without setting `pluginConfig.endpoint` and it auto-registers with **`try.getaxonflow.com`** on first load. The first-load disclosure banner surfaces this in your plugin logs before the registration POST fires. Auto-registration credentials persist at `$AXONFLOW_CONFIG_DIR/try-registration.json` (mode `0600`).

**Use only for early exploration of the plugin's behaviour. Not for production workloads, regulated environments, real user data, personal data, or any other sensitive information.**

| What goes to `try.getaxonflow.com` | What does NOT |
|---|---|
| Tool name + arguments before each governed call | LLM provider API keys |
| Outbound message bodies before delivery (PII/secret scan) | OpenClaw conversation history outside governed tools |
| Anonymous 7-day heartbeat (plugin version, OS, runtime) | Files outside the OpenClaw runtime |

The endpoint runs against shared Ollama models, rate-limits at 20 req/min · 500 req/day per tenant, and is offered "as is" on a best-effort basis with no SLA, no warranties, no commitment to retention or deletion timelines, and may be modified or discontinued without notice. Read the [Try AxonFlow — Free Trial Server](https://docs.getaxonflow.com/docs/deployment/community-saas/) page for the full disclosure, including [data retention](https://docs.getaxonflow.com/docs/deployment/community-saas/#limitations-and-disclaimers) and [registration mechanics](https://docs.getaxonflow.com/docs/deployment/community-saas/#registration).

### Air-gapped: zero outbound

If you need the plugin to make *no* outbound calls at all — air-gapped lab, regulated network, etc. — set both:

```bash
export AXONFLOW_COMMUNITY_SAAS=0   # disable auto-bootstrap
export AXONFLOW_TELEMETRY=off      # disable 7-day heartbeat
```

…and configure `pluginConfig.endpoint` to a self-hosted AxonFlow on the same network. With these set, no traffic leaves your environment.

### Environment variables (optional)

| Variable | Effect |
|---|---|
| `AXONFLOW_TELEMETRY=off` | Disables the 7-day anonymous heartbeat to `checkpoint.getaxonflow.com`. Accepted off-values: `off`, `0`, `false`, `no`. |
| `AXONFLOW_COMMUNITY_SAAS=0` | Disables auto-registration with `try.getaxonflow.com`. You must then set `pluginConfig.endpoint` for the plugin to enforce policy. Accepted off-values: `0`, `false`, `off`, `no`. |
| `AXONFLOW_CACHE_DIR` | Overrides the per-user cache dir (telemetry stamp, rate-limit backoff). Defaults to `$XDG_CACHE_HOME/axonflow` (Linux), `~/Library/Caches/axonflow` (macOS), `%LOCALAPPDATA%\axonflow` (Windows). |
| `AXONFLOW_CONFIG_DIR` | Overrides the per-user config dir (Community-SaaS registration file, disclosure stamp). Defaults to OS conventions. |
| `AXONFLOW_LICENSE_TOKEN` | AxonFlow Pro plugin-claim license token (begins with `AXON-`). Forwarded on every governed request via the `X-License-Token` header so the agent applies Pro-tier entitlements. Wins over `pluginConfig.licenseToken`. |

### Activate Pro tier

Plugin Pro is the paid tier on top of free Community SaaS — it unlocks longer audit retention, higher per-tenant quotas, and license-gated capabilities. **$9.99 USD for 90 days**, one-time payment, no auto-renewal, 14-day no-questions refund. See [getaxonflow.com/pricing/](https://getaxonflow.com/pricing/) for the full breakdown and the Stripe buy button.

To activate Pro on an installed plugin:

1. **Find your tenant ID.** Run the bundled status CLI from a terminal:

    ```bash
    npx @axonflow/openclaw axonflow-openclaw-status
    ```

    The output includes a `tenant_id:  cs_<uuid>` line — that's the value Stripe Checkout needs to bind the license to your tenant. Copy it. (See [Check status](#check-status) below for the full output shape and `--json` mode.)

2. **Buy at the pricing page.** Visit [getaxonflow.com/pricing/](https://getaxonflow.com/pricing/) and click **Buy Plugin Pro — $9.99**. At Stripe Checkout, paste your `tenant_id` into the **AxonFlow tenant ID** custom field. The agent issues an `AXON-…` token and emails it to the address you used at checkout.
3. **Install the issued license token.** Either set `AXONFLOW_LICENSE_TOKEN=<the token>` in the environment OpenClaw runs in, or set `pluginConfig.licenseToken` in your OpenClaw config.
4. **Reload OpenClaw.** The plugin emits `[AxonFlow] Pro tier active …` on every init alongside the connection canary, and forwards `X-License-Token` on every governed request automatically.

If you lose the token (laptop reinstall, never archived the email), use the recovery CLI below to issue a fresh one against the same email.

### Check status

When you need to know your `tenant_id` (for example to paste it into the Stripe checkout custom field when buying Pro), or you want to confirm which AxonFlow endpoint the plugin is pointed at and whether a Pro license token is wired through:

```bash
# Installed via OpenClaw plugin install:
npx @axonflow/openclaw axonflow-openclaw-status

# Or directly from a clone:
node bin/axonflow-openclaw-status.mjs

# Machine-readable JSON, suitable for piping into jq:
axonflow-openclaw-status --json
```

Sample output (free tier, registered):

```
AxonFlow OpenClaw plugin status

  tenant_id:  cs_demo_tenant_abc123
              (paste this into the Stripe checkout custom field when buying Pro)
  endpoint:   https://try.getaxonflow.com
  tier:       Free
  upgrade:    https://getaxonflow.com/pricing/
```

Sample output (Pro tier active):

```
AxonFlow OpenClaw plugin status

  tenant_id:  cs_demo_tenant_abc123
              (paste this into the Stripe checkout custom field when buying Pro)
  endpoint:   https://try.getaxonflow.com
  tier:       Pro (license token configured)
  license:    …XYZ9 (redacted — last 4 chars only)
```

The license token is **never** printed in full — only the last four characters are shown so you can confirm the token is the one you expect without exposing it via screen-share, copy-paste, or shell history. If `tenant_id` is missing, the CLI points you at `axonflow-openclaw-recover` to re-issue credentials against your registered email.

### Recover lost Community-SaaS credentials

If you registered with Community SaaS, lost the auto-bootstrapped credential file (`$AXONFLOW_CONFIG_DIR/try-registration.json`), and want your tenant + audit history back:

```bash
# Installed via OpenClaw plugin install:
npx @axonflow/openclaw axonflow-openclaw-recover you@example.com

# Or directly from a clone:
node bin/axonflow-openclaw-recover.mjs you@example.com
```

The CLI:
1. Posts your email to `/api/v1/recover` (the platform always returns 202 — anti-enumeration, no signal whether the email is bound or not).
2. Prompts you to paste the magic-link token (or the full magic-link URL) from the email you receive.
3. Posts the token to `/api/v1/recover/verify`, which returns a freshly-issued tenant_id + secret bound to the original email.
4. Persists the new credentials at `$AXONFLOW_CONFIG_DIR/try-registration.json` (mode `0o600`).

Reload OpenClaw and the plugin picks up the recovered registration on the next init — no other config change required. Magic-link tokens are one-shot and short-lived; replays return 401.

---

## What you get

| Capability | What it means in practice |
|---|---|
| **Pre-execution policy check** | Every tool call is scored against 80+ built-in policies (reverse shells, SSRF, credential access, SQLi, prompt injection, path traversal, PII in arguments) before it runs |
| **Approval gates** | Any tool in `highRiskTools` pauses execution and posts a native OpenClaw approval request with policy severity surfaced as approval priority |
| **Outbound message scanning** | Every message to Telegram/Discord/Slack/webhook is scanned for PII and secrets before delivery — redacted, blocked, or passed through per policy |
| **Compliance-grade audit trail** | Every tool call and LLM interaction records the input, output summary, matched policies, decision, and duration |
| **Decision explainability** | Blocked calls return a `decision_id` the agent can pass to `explainDecision()` to see exactly which policy family triggered and why |
| **Session overrides** | Operators can request a time-bounded, audit-logged exception when policy allows it — without leaving the agent |
| **Per-user identity** | `config.userEmail` threads the actual human operator through to every explain/override call, so shared chat agents still produce attributable audits |

---

## How it plugs in

```
┌──────────────────────────────────────────────────────────────┐
│                        OpenClaw Agent                        │
│                                                              │
│  User Message → LLM Call → Tool Execution → Response → User  │
│        │           │             │                       │   │
│        ▼           ▼             ▼                       ▼   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │            @axonflow/openclaw                          │  │
│  │                                                        │  │
│  │  GOVERNANCE (can block / modify):                      │  │
│  │  before_tool_call   (priority 10) → check_input        │  │
│  │  message_sending    (priority 10) → check_output       │  │
│  │                                                        │  │
│  │  AUDIT (observe-only, non-blocking):                   │  │
│  │  after_tool_call    (priority 90) → audit_tool_call    │  │
│  │  llm_input          (priority 90) → record prompt      │  │
│  │  llm_output         (priority 90) → record response    │  │
│  └────────────────────────┬───────────────────────────────┘  │
└───────────────────────────┼──────────────────────────────────┘
                            │
                            ▼
                    ┌───────────────────┐
                    │     AxonFlow      │
                    │  ┌─────┐ ┌─────┐  │
                    │  │Policy│ │Audit│  │
                    │  │Engine│ │Trail│  │
                    │  └─────┘ └─────┘  │
                    │  ┌─────┐          │
                    │  │ PII │          │
                    │  │Scan │          │
                    │  └─────┘          │
                    └───────────────────┘
```

**What stays the same:** your OpenClaw agent config, ClawHub skills, MCP connectors, and channel integrations are unchanged. The plugin only adds lifecycle hooks.

---

## The production problems this solves

These are the three questions that reliably surface the moment an OpenClaw agent hits real users or regulators.

### 1. "The tool that phones home"

A `web_fetch` skill is installed from ClawHub. An agent uses it to look up product docs. Then a user asks, *"Summarize my customer list"* — the agent calls `web_fetch` with customer emails in the URL. The data leaves your infrastructure. OpenClaw executed the tool correctly; nobody checked what it was sending.

**What the plugin does:** `check_input` fires before `web_fetch` runs, scans the URL arguments against PII and exfiltration policies, and blocks the call with a decision ID.

### 2. "The MCP response full of PII"

An MCP connector queries your CRM for "recent support tickets." The MCP server returns 50 rows with names, emails, phone numbers. All of it flows into the LLM context. OpenClaw managed the connection; SecretRef protected the credentials; the *data itself* was never inspected.

**What the plugin does:** `check_output` fires on `message_sending` before anything reaches the user channel, and scans every outbound message for SSN, credit card, API key, and other 80+ policy matches — redacting or blocking per policy.

### 3. "The compliance question nobody can answer"

Six months later, a regulator asks: *"For this interaction on March 14, which tools were called, what data did they access, which policies were in effect, and why was the response allowed?"* OpenClaw's execution logs show a tool was called and succeeded. The *decision context* does not exist.

**What the plugin does:** every governed call emits a structured audit record with tool, input, output summary, matched policies, decision, and duration. Search via `searchAuditEvents()` or the Customer Portal.

---

## Try AxonFlow on a real plugin rollout

We're opening limited **Plugin Design Partner** slots.

30-minute hook lifecycle review, policy pack scoping, override workflow design, and IDE/CLI rollout pattern walkthrough — for solo developers and small teams putting governance on OpenClaw.

[Apply here](https://getaxonflow.com/plugins/design-partner?utm_source=readme_plugin_openclaw) or email [design-partners@getaxonflow.com](mailto:design-partners@getaxonflow.com). Personal email is fine — solo developers welcome.

### See AxonFlow in Action

Three short videos covering different angles of the platform:

- **[Community Quickstart Demo (Code + Terminal, 2.5 min)](https://youtu.be/BSqU1z0xxCo)** — governed calls, PII block, Gateway Mode with LangChain/CrewAI, and MAP from YAML
- **[Runtime Control Demo (Portal + Workflow, 3 min)](https://youtu.be/6UatGpn7KwE)** — approvals, retry safety, execution state, and the audit viewer
- **[Architecture Deep Dive (12 min)](https://youtu.be/Q2CZ1qnquhg)** — how the control plane works, policy enforcement flow, and multi-agent planning

### Plugin Evaluation Tier (Free 90-day License)

Outgrown Community on a real plugin install? Evaluation unlocks the capacity and features that matter for plugin users — without moving to Enterprise yet:

| Capability | Community | Evaluation (Free) | Enterprise |
|---|---|---|---|
| Tenant policies | 20 | 50 | Unlimited |
| Org-wide policies | 0 | 5 | Unlimited |
| Audit retention | 3 days | 14 days | Up to 10 years |
| HITL approval gates | — | 25 pending, 24h expiry | Unlimited, 24h |
| Evidence export (CSV/JSON) | — | 5,000 records · 14d window · 3/day | Unlimited |
| Policy simulation | — | 300/day | Unlimited |
| Session overrides (self-service unblock) | — | — | Enterprise-only |

Org-wide policies and session overrides are **Enterprise-only** — those are the actual upgrade triggers for plugin users.

[Get a free Plugin Evaluation license](https://getaxonflow.com/plugins/evaluation-license?utm_source=readme_plugin_openclaw_eval)

---

## Install

This is a **three-step** install: stand up the AxonFlow platform, add the plugin to OpenClaw, then point the plugin at the platform. The plugin alone does not enforce policy — it is a thin client that talks to an AxonFlow agent gateway. If the platform is not installed and reachable, governed tool calls have nothing to evaluate against. **Skipping Step 3 is the most common mistake**: the platform is running locally but the plugin still falls back to Community SaaS because no endpoint is configured.

### Step 1: install the AxonFlow platform

For any real workload, run AxonFlow on your own infrastructure via Docker Compose:

```bash
git clone https://github.com/getaxonflow/axonflow.git
cd axonflow && docker compose up -d

# verify
curl -s http://localhost:8080/health | jq .
```

Follow the [Getting Started](https://docs.getaxonflow.com/docs/getting-started/) guide for prerequisites (Docker Engine or Desktop, Docker Compose v2, 4 GB RAM, 10 GB disk) and the [Self-Hosted Deployment Guide](https://docs.getaxonflow.com/docs/deployment/self-hosted/) for production options. For production with real users or clients, run Community Edition with a free 90-day [Evaluation License](https://docs.getaxonflow.com/docs/deployment/evaluation-rollout-guide/) or [AxonFlow Enterprise](https://docs.getaxonflow.com/docs/deployment/community-to-enterprise-migration/).

> Skipping Step 1 makes the plugin fall back to the [Community SaaS](https://docs.getaxonflow.com/docs/deployment/community-saas/) endpoint at `try.getaxonflow.com` for early exploration only. **Do not skip Step 1 for any real workload** — see the [Privacy notice](#where-your-data-goes) above.

### Step 2: install the plugin

Requires OpenClaw **2026.4.15 or later** (CVE floor). Upgrade with `npm install -g openclaw@latest` if needed.

```bash
openclaw plugins install @axonflow/openclaw@latest
```

We recommend the npm-spec form as our primary install path. npm is our source-of-truth registry — every release is published there first, with the long track record and stability you'd expect from a mature package registry. The CLI resolves the npm spec and downloads the latest tarball directly.

To pin a specific version (recommended in production / CI):

```bash
openclaw plugins install @axonflow/openclaw@2.1.0
```

The `clawhub:@axonflow/openclaw` form is also supported and pulls from the [ClawHub](https://clawhub.ai/plugins/%40axonflow%2Fopenclaw) mirror, which we publish to alongside [npm](https://www.npmjs.com/package/@axonflow/openclaw) on each release.

<details>
<summary>On an older OpenClaw CLI? The ENOENT workaround still applies.</summary>

OpenClaw versions before 2026.4.14 had a bug ([openclaw/openclaw#66618](https://github.com/openclaw/openclaw/issues/66618)) that made scoped packages fail with `ENOENT .../openclaw-clawhub-package-XXXXXX/@axonflow/openclaw.zip` — both forms of the install command hit it. The fix shipped in 2026.4.14. If you cannot upgrade, install from npm directly:

```bash
# Captures the exact tgz filename so a stale tgz in CWD doesn't get picked up
TGZ=$(npm pack @axonflow/openclaw 2>/dev/null | tail -1)
openclaw plugins install "./$TGZ"
```
</details>

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

See [Configure](#configure) below for the full pluginConfig schema (`highRiskTools`, `governedTools`, `onError`, `userEmail`, etc.).

---

## Configure

[Step 3](#step-3-point-the-plugin-at-the-platform) above covers the minimum config (`endpoint` + optional `clientId` / `clientSecret`). The full pluginConfig schema is below.

### Full configuration reference

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `endpoint` | No | `https://try.getaxonflow.com` (Community SaaS) when unset; `http://localhost:8080` when self-hosted with no endpoint specified | AxonFlow agent gateway URL |
| `clientId` | No | `"community"` (self-hosted) or auto-bootstrapped `cs_<uuid>` (Community SaaS) | Tenant identity for data isolation. Override for Evaluation License or Enterprise tenants. |
| `clientSecret` | No | `""` (self-hosted) or auto-bootstrapped (Community SaaS) | Basic-auth secret paired with `clientId`. Required for self-hosted Community Edition with an Evaluation License or AxonFlow Enterprise; auto-populated for Community SaaS; can be left unset for self-hosted Community Edition without a license. |
| `licenseToken` | No | `process.env.AXONFLOW_LICENSE_TOKEN` if set | AxonFlow Pro plugin-claim license token (begins with `AXON-`). When set, the plugin sends `X-License-Token` on every governed request and the agent applies Pro-tier entitlements (extended retention, higher quotas, license-gated capabilities). Get one at [getaxonflow.com/pricing/](https://getaxonflow.com/pricing/) — buy through Stripe Checkout, the token arrives by email. Env var wins over `pluginConfig.licenseToken`. |
| `userEmail` | No | — | Per-user identity forwarded on explain/override calls. Shared agents should set this from session context. |
| `highRiskTools` | No | `[]` | Tools that require human approval even when policy allows |
| `governedTools` | No | `[]` (all) | Tools to govern. Empty = all tools. |
| `excludedTools` | No | `[]` | Tools to exclude from governance. Takes precedence over `governedTools`. |
| `defaultOperation` | No | `"execute"` | Operation type for `check_input` (`"execute"` or `"query"`) |
| `onError` | No | `"block"` | Governs behavior on **auth/config errors only** (401/403). `"block"` denies the tool call with a message telling the operator to fix configuration; `"allow"` lets the call through ungoverned. Does not apply to network/transient errors — see Fail behavior below. |
| `requestTimeoutMs` | No | `8000` | Timeout for policy checks, output scans, audit writes, and health checks |

### Fail behavior

The plugin classifies errors from the AxonFlow client into two buckets and applies different rules per hook.

| Hook | Transient network error (timeout, DNS, connection refused, 5xx) | Auth/config error (401 / 403) |
|---|---|---|
| `before_tool_call` | **Always fail-open** — tool call proceeds regardless of `onError`. Transient infrastructure issues should not block legitimate dev workflows. |  Respects `onError`. With the default `"block"`, the tool call is denied with a message pointing at the misconfiguration. With `"allow"`, the call proceeds ungoverned. |
| `message_sending` | Respects `onError`. With `"block"` (default), the outbound message is cancelled. With `"allow"`, it is delivered ungoverned. | Same as network error — respects `onError`. |
| `after_tool_call`, `llm_input`, `llm_output` (audit) | Always silently caught. Governance was already enforced on the pre-execution hook. | Always silently caught. |

If you need tool-execution itself to fail-closed during an AxonFlow outage (for example on a production infrastructure agent), pair the plugin with an OpenClaw-side health check or a front-door liveness gate — the plugin alone will not achieve that for `before_tool_call`.

---

## Use-case recipes

### DevOps / coding agent — heavy exec usage

```yaml
plugins:
  @axonflow/openclaw:
    endpoint: http://localhost:8080
    highRiskTools: [exec, process]
    excludedTools: [get_current_time, list_models]
    onError: block
```

### Customer support agent — Slack/Discord/Telegram

```yaml
plugins:
  @axonflow/openclaw:
    endpoint: http://localhost:8080
    highRiskTools: [message, execute_sql, send_email]
    onError: block
```

### Self-healing infrastructure agent — highest risk

```yaml
plugins:
  @axonflow/openclaw:
    endpoint: http://localhost:8080
    highRiskTools: [exec, process, web_fetch]
    onError: block  # auth-error path and message_sending fail-closed; see Fail behavior above
```

More examples — content/social agents, data analysts, RAG pipelines — in the [integration guide](https://docs.getaxonflow.com/docs/integration/openclaw/#use-case-configuration-examples).

---

## MCP tools available to your agent

Beyond the lifecycle hooks, OpenClaw agents can call **10 MCP tools** via the agent's MCP server at `/api/v1/mcp-server`. These are served by the platform (not the plugin), so new tools become available to every plugin without a code change.

**Governance (6):** `check_policy`, `check_output`, `audit_tool_call`, `list_policies`, `get_policy_stats`, `search_audit_events`

**Explainability & overrides (4):** `explain_decision`, `create_override`, `delete_override`, `list_overrides`

When a tool call is blocked, the agent can surface the `decision_id` to the operator, call `explain_decision` to reveal the triggering policy family, and — if the decision is overridable — call `create_override` with mandatory justification for a short-lived, audit-logged exception. Operators never leave the OpenClaw session.

See [Decision Explainability](https://docs.getaxonflow.com/docs/governance/explainability/) and [Session Overrides](https://docs.getaxonflow.com/docs/governance/overrides/).

---

## What's covered today, and what's not

**Protected today:**
- Tool inputs before execution
- Outbound messages before delivery
- Tool and LLM audit trails (including search & explainability)
- Decision-level overrides with per-user attribution

**Not protected yet:**
- Tool results written into the session transcript (OpenClaw's `tool_result_persist` hook is synchronous and cannot call AxonFlow's HTTP APIs)

PII in tool results is still caught by `message_sending` before it reaches the end user, but it is visible to the LLM. When OpenClaw adds async support for `tool_result_persist`, this plugin will add transcript scanning immediately. Upstream issue: [openclaw/openclaw#58558](https://github.com/openclaw/openclaw/issues/58558).

---

## Latency

| Operation | Typical overhead |
|-----------|-----------------|
| Policy pre-check | 2–5 ms |
| PII / secrets detection | 1–3 ms |
| SQL-injection scan | 1–2 ms |
| Audit write (async) | 0 ms (non-blocking) |
| **Total per-tool overhead** | **3–10 ms** |

Imperceptible for interactive agents.

---

## Starter policies

The [policies directory](./policies) ships research-backed starter policies addressing the top 10 OpenClaw security risks — reverse shells, SSRF, credential exfiltration, path traversal, agent config poisoning, prompt injection, and more. Ready-to-use SQL INSERT statements and setup instructions included.

---

## Telemetry

The plugin sends a one-time anonymous ping on initialization so AxonFlow can understand adoption and environment shape. Includes plugin version, OS/arch, Node.js version, AxonFlow platform version, hook configuration summary. **Never** includes message contents, tool arguments, or policy data.

Opt out: set `AXONFLOW_TELEMETRY=off` in the environment OpenClaw runs in.

`DO_NOT_TRACK` is **not** honored as an opt-out for AxonFlow telemetry. It is commonly inherited from host tools and developer environments, which makes it an unreliable expression of user intent.

---

## Testing

Unit tests (jest, mock fetch — no live stack needed):

```bash
npm test
```

Smoke E2E (requires a live AxonFlow stack at `localhost:8080`):

```bash
npm ci && npm run build
# Start a local AxonFlow stack first — `docker compose up -d` in
# the axonflow repo, or point AXONFLOW_ENDPOINT at an existing one.
node tests/e2e/smoke-block-context.mjs
```

The smoke scenario uses `AxonFlowClient.mcpCheckInput` to fire a SQLi-bearing statement against a running platform and asserts the response carries richer-context fields (`decision_id`, `risk_level`, `policy_matches`). Exits 0 with a `SKIP:` message if no stack is reachable.

For the broader validation story — explain-decision, override lifecycle, audit-filter parity, cache invalidation — see the [OpenClaw integration guide](https://docs.getaxonflow.com/docs/integration/openclaw/).

---

## Links

- **[OpenClaw Integration Guide](https://docs.getaxonflow.com/docs/integration/openclaw/)** — the full walkthrough (recommended starting point)
- [AxonFlow Documentation](https://docs.getaxonflow.com)
- [Policy Enforcement](https://docs.getaxonflow.com/docs/mcp/policy-enforcement/)
- [Decision Explainability](https://docs.getaxonflow.com/docs/governance/explainability/)
- [Session Overrides](https://docs.getaxonflow.com/docs/governance/overrides/)
- [PII Detection](https://docs.getaxonflow.com/docs/security/pii-detection/)
- [Audit Logging](https://docs.getaxonflow.com/docs/governance/audit-logging/)
- Sister plugins: [Claude Code](https://github.com/getaxonflow/axonflow-claude-plugin) · [Cursor](https://github.com/getaxonflow/axonflow-cursor-plugin) · [Codex](https://github.com/getaxonflow/axonflow-codex-plugin)

## License

MIT
