# @axonflow/openclaw

**Governance for OpenClaw agents: block dangerous tool calls, require human approval on high-risk actions, redact PII from outbound messages, and keep a compliance-grade audit trail — without changing a single line of your agent code.**

[![npm](https://img.shields.io/npm/v/%40axonflow%2Fopenclaw?color=%2300A36C)](https://www.npmjs.com/package/@axonflow/openclaw)
[![ClawHub](https://img.shields.io/badge/ClawHub-listed-00A36C)](https://clawhub.ai/plugins/%40axonflow%2Fopenclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **→ Full integration walkthrough:** **[docs.getaxonflow.com/docs/integration/openclaw](https://docs.getaxonflow.com/docs/integration/openclaw/)** — architecture, hook coverage, policy examples, and troubleshooting.

---

## Why this plugin exists

OpenClaw is a strong agent runtime. It is also a serious production security problem the moment you take it past a prototype:

- **[135,000+ publicly exposed instances](https://www.bitsight.com/blog/openclaw-ai-security-risks-exposed-instances)** deployed without central policy enforcement
- **[13+ CVEs disclosed in 2026](https://github.com/jgamblin/OpenClawCVEs/)**, several at CVSS 9.8+
- **[1,184 malicious skills](https://cyberpress.org/clawhavoc-poisons-openclaws-clawhub-with-1184-malicious-skills/)** poisoned in ClawHub via the ClawHavoc supply-chain attack
- **No native PII/secrets scanning**, no SQL-injection defense, no compliance-grade audit trail, no org-wide tool policy, no approval workflow

OpenClaw handles agent runtime, MCP connectivity, channels, and tool execution. It was never intended to be the place you enforce governance. This plugin adds the governance layer on top, so OpenClaw keeps doing what it does well and AxonFlow takes over the "is this allowed, should this redact, who approved, where is the audit record" questions.

**AxonFlow governs. OpenClaw orchestrates. Your data stays on your infrastructure.** No LLM provider keys leave your machine — OpenClaw still makes every LLM call; AxonFlow only evaluates policies and records audit trails.

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

Requires OpenClaw **2026.4.14 or later**. Upgrade with `npm install -g openclaw@latest` if needed.

```bash
openclaw plugins install @axonflow/openclaw
```

Available on [ClawHub](https://clawhub.ai/plugins/%40axonflow%2Fopenclaw) and [npm](https://www.npmjs.com/package/@axonflow/openclaw). The `clawhub:@axonflow/openclaw` form works if you prefer to be explicit about the source.

<details>
<summary>On an older OpenClaw CLI? The ENOENT workaround still applies.</summary>

OpenClaw versions before 2026.4.14 had a bug ([openclaw/openclaw#66618](https://github.com/openclaw/openclaw/issues/66618)) that made scoped packages fail with `ENOENT .../openclaw-clawhub-package-XXXXXX/@axonflow/openclaw.zip` — both forms of the install command hit it. The fix shipped in 2026.4.14. If you cannot upgrade, install from npm directly:

```bash
# Captures the exact tgz filename so a stale tgz in CWD doesn't get picked up
TGZ=$(npm pack @axonflow/openclaw 2>/dev/null | tail -1)
openclaw plugins install "./$TGZ"
```
</details>

### Start AxonFlow

The plugin connects to AxonFlow, a self-hosted governance platform. AxonFlow must be running before the plugin loads. Everything stays on your infrastructure.

```bash
git clone https://github.com/getaxonflow/axonflow.git
cd axonflow && docker compose up -d
```

See [Getting Started](https://docs.getaxonflow.com/docs/getting-started/) for production deployment options.

---

## Configure

The plugin works without any configuration. Install it and run a tool — on first run it registers against AxonFlow Community SaaS at `https://try.getaxonflow.com` and persists the resulting credentials to `~/.config/axonflow/try-registration.json` (mode 0600). Every plugin init logs:

```
[AxonFlow] Connected to AxonFlow at https://try.getaxonflow.com (mode=community-saas)
```

Community SaaS is intended for basic testing and evaluation. For real workflows, real systems, or sensitive data, point the plugin at a self-hosted AxonFlow:

```yaml
# openclaw.config.yaml
plugins:
  @axonflow/openclaw:
    endpoint: http://localhost:8080
    highRiskTools:
      - web_fetch
      - message
```

Setting any of `endpoint` / `clientId` / `clientSecret` opts you into self-hosted mode. The Community-SaaS bootstrap is skipped, and the plugin uses your values verbatim. The same canary log line confirms the destination on every init:

```
[AxonFlow] Connected to AxonFlow at http://localhost:8080 (mode=self-hosted)
```

### Full configuration reference

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `endpoint` | No | `https://try.getaxonflow.com` (Community SaaS) when unset; `http://localhost:8080` when self-hosted with no endpoint specified | AxonFlow agent gateway URL |
| `clientId` | No | `"community"` (self-hosted) or auto-bootstrapped `cs_<uuid>` (Community SaaS) | Tenant identity for data isolation. Override for evaluation/enterprise. |
| `clientSecret` | No | `""` (self-hosted) or auto-bootstrapped (Community SaaS) | Basic-auth secret paired with `clientId`. Required for evaluation/enterprise tenants; leave unset in community mode. |
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
